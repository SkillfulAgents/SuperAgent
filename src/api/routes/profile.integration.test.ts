import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { PNG } from 'pngjs'
import { SignJWT } from 'jose'
import Database from 'better-sqlite3'

let directory: string
let db: typeof import('@shared/lib/db')
let sqlite: Database.Database
let authModule: typeof import('@shared/lib/auth')
let app: Hono
const base = 'http://localhost:47891'
const issuer = 'https://identity.example.com'

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-avatars-'))
  vi.stubEnv('SUPERAGENT_DATA_DIR', directory)
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', 'avatar-test-secret-0123456789abcdef0123456789abcdef')
  vi.stubEnv('TRUSTED_ORIGINS', base)
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
  app = new Hono()
  app.use('*', defaultCacheControl)
  app.route('/api/profile', profile)
})

beforeEach(() => {
  for (const table of ['session', 'account', 'user', 'verification']) sqlite.prepare(`DELETE FROM ${table}`).run()
})
afterAll(async () => {
  authModule.resetAuth()
  sqlite.close()
  await db.closeDatabase()
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
    expect((await upload(signedIn.token!, Buffer.alloc(1024 * 1024 + 1))).status).toBe(413)
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

/** Serve discovery and a token endpoint whose id_token carries `claims()` at call time. */
function stubPlatformIssuer(claims: () => Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` })
    }
    if (url === `${issuer}/token`) {
      const idToken = await new SignJWT({ email_verified: true, ...claims() })
        .setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer).setAudience('test-client').setIssuedAt().setExpirationTime('5m')
        .sign(new TextEncoder().encode('test-only-signing-key-with-32-bytes'))
      return Response.json({ access_token: 'test-access', token_type: 'Bearer', id_token: idToken, expires_in: 3600 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }))
}

/** Drive the real sign-in → callback round trip for the platform provider. */
async function signInThroughCallback() {
  const auth = authModule.getAuth()
  const start = await auth.handler(new Request(`${base}/api/auth/sign-in/oauth2`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ providerId: 'platform', callbackURL: `${base}/` }),
  }))
  expect(start.status).toBe(200)
  const state = new URL((await start.json()).url).searchParams.get('state')!
  const cookie = start.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
  const finish = await auth.handler(new Request(`${base}/api/auth/oauth2/callback/platform?${new URLSearchParams({ code: 'test-code', state, iss: issuer })}`, { headers: { cookie } }))
  expect(finish.headers.get('location')).toBe(`${base}/`)
}

describe('browser OIDC image propagation', () => {
  it('persists and refreshes the actual callback image while preserving a workspace override and member identity', async () => {
    let picture = 'https://example.com/first.png'
    stubPlatformIssuer(() => ({ sub: 'sub_member_one', name: 'Ada Lovelace', email: 'ada@example.com', picture }))
    try {
      await signInThroughCallback()
      expect(sqlite.prepare('SELECT image FROM user').get()).toEqual({ image: picture })
      const override = '/api/profile/images/00000000-0000-4000-8000-000000000001.png'
      sqlite.prepare('UPDATE user SET avatar_override = ?').run(override)
      picture = 'https://example.com/new.png'
      await signInThroughCallback()
      expect(sqlite.prepare('SELECT image, avatar_override FROM user').get()).toEqual({ image: picture, avatar_override: override })
      expect(sqlite.prepare('SELECT account_id FROM account').all()).toEqual([{ account_id: 'sub_member_one' }])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('browser OIDC role', () => {
  const ORG = 'org_role_test'
  const CLAIMS = 'https://platform.skillfulagents.dev/claims'
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const roleOf = (email: string) => (sqlite.prepare('SELECT role FROM user WHERE email = ?').get(email) as { role: string }).role

  it('copies the platform role at account creation and at every repeat sign-in on a platform-controlled deployment', async () => {
    vi.stubEnv('PLATFORM_TOKEN', `${b64({ alg: 'RS256' })}.${b64({ orgId: ORG })}.sig`)
    let member: { sub: string; email: string; role?: string } = { sub: 'sub_one', email: 'one@example.com', role: 'member' }
    stubPlatformIssuer(() => ({ sub: member.sub, name: member.email, email: member.email, [`${CLAIMS}/org_id`]: ORG, [`${CLAIMS}/role`]: member.role }))
    try {
      await signInThroughCallback()
      expect(roleOf('one@example.com')).toBe('user')
      member = { sub: 'sub_two', email: 'two@example.com', role: 'admin' }
      await signInThroughCallback()
      expect(roleOf('two@example.com')).toBe('admin')
      member = { sub: 'sub_two', email: 'two@example.com', role: 'member' }
      await signInThroughCallback()
      expect(roleOf('two@example.com')).toBe('user')
      // Removed and re-invited: a new platform identity links to the same user,
      // whose older platform account still holds an admin id_token.
      member = { sub: 'sub_two', email: 'two@example.com', role: 'admin' }
      await signInThroughCallback()
      member = { sub: 'sub_two_reinvited', email: 'two@example.com', role: 'member' }
      await signInThroughCallback()
      expect(roleOf('two@example.com')).toBe('user')
      expect(sqlite.prepare(`SELECT count(*) AS n FROM account WHERE provider_id = 'platform' AND user_id = (SELECT id FROM user WHERE email = ?)`).get('two@example.com')).toEqual({ n: 2 })
      member = { sub: 'sub_two_reinvited', email: 'two@example.com', role: 'member' }
      await signInThroughCallback()
      expect(roleOf('two@example.com')).toBe('user')
      // A token without a role claim demotes rather than keeping the old role.
      member = { sub: 'sub_two_reinvited', email: 'two@example.com', role: 'admin' }
      await signInThroughCallback()
      expect(roleOf('two@example.com')).toBe('admin')
      member = { sub: 'sub_two_reinvited', email: 'two@example.com' }
      await signInThroughCallback()
      expect(roleOf('two@example.com')).toBe('user')
    } finally {
      vi.unstubAllGlobals()
      vi.stubEnv('PLATFORM_TOKEN', '')
    }
  })

  it('keeps first-user bootstrap and ignores the role claim on a self-hosted deployment', async () => {
    stubPlatformIssuer(() => ({ sub: 'sub_one', name: 'One', email: 'one@example.com', [`${CLAIMS}/role`]: 'member' }))
    try {
      await signInThroughCallback()
      expect(roleOf('one@example.com')).toBe('admin')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
