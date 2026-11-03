import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { PNG } from 'pngjs'
import { createOidcTestServer, completeOidcLogin, type OidcTestServer } from '@shared/lib/auth/testing/oidc-server'
import { handleAuthRequest } from '@shared/lib/auth/handler'
import Database from 'better-sqlite3'

let directory: string
let db: typeof import('@shared/lib/db')
let sqlite: Database.Database
let authModule: typeof import('@shared/lib/auth')
let app: Hono
const base = 'http://localhost:47891'
let oidc: OidcTestServer

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-avatars-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', directory)
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', 'avatar-test-secret-0123456789abcdef0123456789abcdef')
  vi.stubEnv('TRUSTED_ORIGINS', base)
  vi.stubEnv('PLATFORM_TOKEN', '')
  oidc = await createOidcTestServer()
  oidc.state.acceptedRedirectUri = `${base}/api/auth/oauth2/callback/platform`
  const issuer = oidc.state.issuer
  vi.stubEnv('AUTH_PROVIDERS_JSON', JSON.stringify([{
    id: 'platform', type: 'oidc', issuer, discoveryUrl: `${issuer}/.well-known/openid-configuration`, clientId: 'test-client', scopes: ['openid', 'profile', 'email'],
  }]))
  db = await import('@shared/lib/db')
  await db.openDatabase()
  // A second connection to the same file for raw seeding and assertions.
  sqlite = new Database(path.join(directory, 'superagent.db'))
  authModule = await import('@shared/lib/auth')
  const profile = (await import('./profile')).default
  const { defaultCacheControl } = await import('../middleware/default-cache-control')
  const { apiErrorHandler } = await import('../error-handler')
  app = new Hono()
  app.use('*', defaultCacheControl)
  app.route('/api/profile', profile)
  // The production handler, not Hono's default: bodyLimit's 413 is thrown.
  app.onError(apiErrorHandler)
})

beforeEach(() => {
  for (const table of ['session', 'account', 'user', 'verification']) sqlite.prepare(`DELETE FROM ${table}`).run()
})
afterAll(async () => {
  authModule.resetAuth()
  sqlite.close()
  await db.closeDatabase()
  await oidc.close()
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

async function login() {
  return authModule.getAuth().api.signUpEmail({ body: { name: 'Ada Lovelace', email: 'ada@example.com', password: 'TestingPassword123!' } })
}
function png(): Buffer {
  const image = new PNG({ width: 4, height: 4 })
  image.data.fill(200)
  return PNG.sync.write(image)
}
function upload(token: string, body = png(), contentType = 'image/png') {
  return app.request('/api/profile/avatar', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': contentType }, body: new Uint8Array(body) })
}

describe('profile avatar API', () => {
  it('stores an override, returns an authenticated image, refreshes the session, and restores the provider photo', async () => {
    const signedIn = await login()
    const headers = { authorization: `Bearer ${signedIn.token}` }
    await (await authModule.getAuth().$context).internalAdapter.updateUser(signedIn.user.id, { image: 'https://example.com/provider.png' })
    const response = await upload(signedIn.token!)
    expect(response.status).toBe(200)
    const { avatarOverride } = await response.json()
    const image = await app.request(avatarOverride, { headers })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(image.headers.get('cache-control')).toContain('private')
    expect(PNG.sync.read(Buffer.from(await image.arrayBuffer())).width).toBe(4)
    expect((await app.request(avatarOverride)).status).toBe(401)
    const session = await authModule.getAuth().api.getSession({ headers: new Headers(headers) })
    expect(session?.user.avatarOverride).toBe(avatarOverride)
    expect(session?.user.image).toBe('https://example.com/provider.png')
    expect((await app.request('/api/profile/avatar', { method: 'DELETE', headers })).status).toBe(200)
    expect(sqlite.prepare('SELECT image, avatar_override FROM user').get()).toEqual({ image: 'https://example.com/provider.png', avatar_override: null })
    expect((await app.request(avatarOverride, { headers })).status).toBe(404)
  })

  it('validates uploaded image references with a covering index lookup', async () => {
    const signedIn = await login()
    const { avatarOverride } = await (await upload(signedIn.token!)).json()
    const prepare = vi.spyOn(Database.prototype, 'prepare')
    try {
      expect((await app.request(avatarOverride, { headers: { authorization: `Bearer ${signedIn.token}` } })).status).toBe(200)
      const lookup = prepare.mock.calls.find(([query]) => query.includes('where "user"."avatar_override" ='))?.[0]
      expect(lookup).toBeDefined()
      // Explain the actual image route query against the fully migrated DB.
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${lookup!}`).all(avatarOverride, 1)
      expect(plan).toEqual([expect.objectContaining({
        detail: expect.stringContaining('USING COVERING INDEX user_avatar_override_idx'),
      })])
    } finally {
      prepare.mockRestore()
    }
  })

  it('removes the stored photo when the user is deleted', async () => {
    const signedIn = await login()
    const { avatarOverride } = await (await upload(signedIn.token!)).json()
    const file = path.join(directory, 'profile-photos', path.basename(avatarOverride))
    expect(fs.existsSync(file)).toBe(true)
    await (await authModule.getAuth().$context).internalAdapter.deleteUser(signedIn.user.id)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('rejects corrupt, oversized, and non-raster uploads without changing a saved photo', async () => {
    const signedIn = await login()
    const first = await (await upload(signedIn.token!)).json()
    expect((await upload(signedIn.token!, Buffer.from('<svg/>'), 'image/svg+xml')).status).toBe(415)
    expect((await upload(signedIn.token!, Buffer.from('bad png'))).status).toBe(400)
    const oversized = await upload(signedIn.token!, Buffer.alloc(1024 * 1024 + 1))
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({ error: 'Payload Too Large' })
    const duplicateHeader = Buffer.concat([png().subarray(0, 33), png().subarray(8)])
    expect((await upload(signedIn.token!, duplicateHeader)).status).toBe(400)
    const interlaced = png()
    interlaced[28] = 1
    expect((await upload(signedIn.token!, interlaced)).status).toBe(400)
    const largeDimensions = png()
    largeDimensions.writeUInt32BE(100_000, 16)
    expect((await upload(signedIn.token!, largeDimensions)).status).toBe(400)
    expect(sqlite.prepare('SELECT avatar_override FROM user').get()).toEqual({ avatar_override: first.avatarOverride })
  })

  it('only writes the signed-in user and does not accept an override through update-user', async () => {
    const signedIn = await login()
    const response = await authModule.getAuth().handler(new Request(`${base}/api/auth/update-user`, {
      method: 'POST', headers: { authorization: `Bearer ${signedIn.token}`, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ avatarOverride: '/api/profile/images/00000000-0000-4000-8000-000000000001.png' }),
    }))
    expect([200, 400]).toContain(response.status)
    expect(sqlite.prepare('SELECT avatar_override FROM user').get()).toEqual({ avatar_override: null })
    expect((await app.request('/api/profile/images/%2E%2E%2Fsettings.json', { headers: { authorization: `Bearer ${signedIn.token}` } })).status).toBe(404)
    expect((await app.request('/api/profile/avatar', { method: 'DELETE' })).status).toBe(401)
  })
})

describe('browser OIDC image propagation', () => {
  it('persists and refreshes the actual callback image while preserving a workspace override and member identity', async () => {
    let picture = 'https://example.com/first.png'
    async function callback() {
      oidc.state.profile.picture = picture
      const finish = await completeOidcLogin(handleAuthRequest, base)
      expect(finish.headers.get('location')).toBe(`${base}/`)
      expect(oidc.state.failures).toEqual([])
    }
    await callback()
    expect(sqlite.prepare('SELECT image FROM user').get()).toEqual({ image: picture })
    const override = '/api/profile/images/00000000-0000-4000-8000-000000000001.png'
    sqlite.prepare('UPDATE user SET avatar_override = ?').run(override)
    picture = 'https://example.com/new.png'
    await callback()
    expect(sqlite.prepare('SELECT image, avatar_override FROM user').get()).toEqual({ image: picture, avatar_override: override })
    expect(sqlite.prepare('SELECT account_id FROM account').all()).toEqual([{ account_id: 'sub_member_one' }])
  })
})
