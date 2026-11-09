import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { auditLog, teamDirectories, user } from '@shared/lib/db/schema'
import { backgroundSettled } from '@shared/lib/background'

const state = vi.hoisted(() => ({ db: null as TestDatabase['db'] | null }))
vi.mock('@shared/lib/db', () => ({ get db() { return state.db } }))
vi.mock('@shared/lib/auth/secret', () => ({ getOrCreateAuthSecret: async () => 'team-directory-test-secret' }))
vi.mock('../middleware/auth', () => ({
  Authenticated: (): MiddlewareHandler => async (c, next) => {
    const id = c.req.header('Test-User')
    if (!id) return c.json({ error: 'Unauthorized' }, 401)
    c.set('user' as never, { id, role: id === 'admin' ? 'admin' : 'user' } as never)
    return next()
  },
  IsAdmin: (): MiddlewareHandler => async (c, next) =>
    c.req.header('Test-User') === 'admin' ? next() : c.json({ error: 'Forbidden' }, 403),
}))

import routes from './team-directories'
import { registerDirectoryProvider } from '@shared/lib/team-directory/registry'
import { searchInviteCandidates } from '@shared/lib/team-directory/invite-candidates'
import { disconnectProvisioning, findProvisioner } from '@shared/lib/team-directory/provisioning'
import { createFakeDirectoryProvider, type FakeDirectory } from '@shared/lib/team-directory/testing/fake-directory-provider'
import { DirectoryConnectError } from '@shared/lib/team-directory/types'
import type { DirectoryInstallStatus, StartDirectoryInstallResponse, TeamDirectoriesResponse } from '@shared/lib/team-directory/view-schema'

const BASE = 'https://gamut.example'
const CALLBACK = `${BASE}/api/team-directories/install/callback`

let handle: TestDatabase
let fake: FakeDirectory
let unregister: () => void
const app = new Hono().route('/api/team-directories', routes)

const call = (path: string, init: RequestInit & { as?: string | null } = {}) => app.request(`/api/team-directories${path === '/' ? '' : path}`, {
  ...init,
  headers: { ...(init.as === null ? {} : { 'Test-User': init.as ?? 'admin' }), 'Content-Type': 'application/json', ...init.headers },
})
const post = (path: string, body: unknown, as?: string) => call(path, { method: 'POST', body: JSON.stringify(body), as })
const status = async (installId: string) => (await (await call(`/install/${installId}`)).json()) as DirectoryInstallStatus

/** The browser coming back from the provider's install page: no session, only the query. */
const returnFrom = (url: string, query: Record<string, string> = {}) => {
  const target = new URL(url)
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value)
  const state = target.searchParams.get('state')!
  const back = new URLSearchParams({ state, ...Object.fromEntries([...target.searchParams].filter(([key]) => key === 'code' || key === 'error')) })
  return call(`/install/callback?${back}`, { as: null })
}

const start = async (key = 'admin-key') => {
  const response = await post('/install', { provider: 'fake', credentials: { key } })
  expect(response.status).toBe(200)
  return await response.json() as StartDirectoryInstallResponse
}

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('HOST_PUBLIC_URL', BASE)
  handle = await createTestDatabase()
  state.db = handle.db
  const now = new Date()
  await handle.db.insert(user).values({ id: 'admin', name: 'Ada Admin', email: 'ada@acme.test', role: 'admin', createdAt: now, updatedAt: now }).run()
  fake = createFakeDirectoryProvider('fake', 'Fake Directory', { provisionFor: 'slack' })
  unregister = registerDirectoryProvider(fake.provider)
  fake.setPeople('acme', [fake.person('acme', 'f1', 'Dana Whitfield', 'dana@acme.test')])
})

afterEach(async () => {
  await backgroundSettled()
  unregister()
  vi.unstubAllEnvs()
  await handle.close()
})

describe('connecting a directory with one token', () => {
  it('is offered for a provider that only returns to HTTPS only when this app has an HTTPS address, and checked before the token is spent', async () => {
    const strict = createFakeDirectoryProvider('strict', 'Strict Directory', { provisionFor: 'slack', httpsRedirectsOnly: true })
    const unregisterStrict = registerDirectoryProvider(strict.provider)
    try {
      const offered = async () => ((await (await call('/')).json()) as TeamDirectoriesResponse).providers
        .filter((p) => p.provisioning?.connectsDirectory).map((p) => p.id)
      expect(await offered()).toEqual(['slack', 'fake', 'strict'])

      vi.stubEnv('HOST_PUBLIC_URL', 'http://localhost:47891')
      // Slack, and any provider like it, falls back to its own form; one that returns anywhere stays.
      expect(await offered()).toEqual(['fake'])
      const refused = await post('/install', { provider: 'strict', credentials: { key: 'admin-key' } })
      expect(refused.status).toBe(400)
      expect(await refused.json()).toEqual({ error: 'Strict Directory only returns to an HTTPS address, and this app is at http://localhost:47891. Use a Strict Directory app you already have.' })
      expect(strict.provisioner.calls).toEqual([])
    } finally {
      unregisterStrict()
    }
  })

  it('deletes the app when the admin starts over, and the install can’t be finished after', async () => {
    const started = await start()
    expect((await call(`/install/${started.installId}`, { method: 'DELETE' })).status).toBe(204)
    expect(fake.provisioner.calls.at(-1)).toEqual({ op: 'delete', detail: { appId: 'DIR1' } })
    expect(await status(started.installId)).toEqual({ status: 'expired' })
    const late = await returnFrom(started.url)
    expect(late.status).toBe(400)
    expect(await late.text()).toContain('Install expired')
    expect(await handle.db.select().from(teamDirectories).all()).toEqual([])
  })

  it('takes only the state it handed out', async () => {
    const started = await start()
    const forged = await call(`/install/callback?${new URLSearchParams({ state: `${started.installId}.not-the-secret-at-all`, code: 'x' })}`, { as: null })
    expect(forged.status).toBe(400)
    expect(await status(started.installId)).toEqual({ status: 'pending' })
    expect((await returnFrom(started.url)).status).toBe(200)
  })

  it('reports the app as left behind when the directory has no app-creation credentials left to delete it with', async () => {
    const started = await start()
    await returnFrom(started.url)
    const [row] = await handle.db.select().from(teamDirectories).all()
    await disconnectProvisioning(row.id)
    const disconnected = await call(`/${row.id}`, { method: 'DELETE' })
    expect(await disconnected.json()).toEqual({ appLeftBehind: true })
    await backgroundSettled()
    expect(fake.provisioner.calls.filter((c) => c.op === 'delete')).toEqual([])
    expect((await call('/unknown', { method: 'DELETE' })).status).toBe(404)
  })

  it('is offered for a provider whose app-creation credentials can make the directory’s app', async () => {
    const body = await (await call('/')).json() as TeamDirectoriesResponse
    expect(body.providers.find((p) => p.id === 'fake')?.provisioning).toMatchObject({ connectsDirectory: true, fields: [{ key: 'key' }] })
    expect(body.providers.find((p) => p.id === 'slack')?.provisioning).toMatchObject({ connectsDirectory: true, fields: [{ key: 'refreshToken' }] })
  })

  it('creates the directory’s app, then one install connects it, with agent apps ready', async () => {
    const started = await start()
    expect(fake.provisioner.calls).toEqual([{ op: 'create-directory', detail: { redirectUrl: CALLBACK, generation: 1 } }])
    const url = new URL(started.url)
    expect(url.searchParams.get('redirect_uri')).toBe(CALLBACK)
    // The install's id, then a secret only the provider's page carries.
    expect(url.searchParams.get('state')).toMatch(new RegExp(`^${started.installId}\\.[\\w-]{20,}$`))
    expect(await status(started.installId)).toEqual({ status: 'pending' })
    expect(await handle.db.select().from(teamDirectories).all()).toEqual([])

    const back = await returnFrom(started.url)
    expect(back.status).toBe(200)
    expect(await back.text()).toContain('ACME connected')

    const outcome = await status(started.installId)
    expect(outcome).toMatchObject({ status: 'connected', tenantName: 'ACME', notices: [] })
    const [row] = await handle.db.select().from(teamDirectories).all()
    expect(row).toMatchObject({ provider: 'fake', tenantId: 'acme', createdByUserId: 'admin', provisioningStatus: 'active' })
    // Everything Gamut keeps for it is sealed: the directory's token, the app-creation key, the app.
    for (const sealed of [row.credentials, row.provisioningCredentials, row.directoryApp]) {
      expect(sealed).toBeTruthy()
      expect(sealed).not.toMatch(/acme-token|admin-key|DIR1/)
    }
    expect(await findProvisioner('slack')).toEqual({ directoryId: row.id, workspace: 'ACME' })
    expect(await handle.db.select({ action: auditLog.action, userId: auditLog.userId }).from(auditLog).all()).toEqual([{ action: 'connected', userId: 'admin' }])

    await backgroundSettled()
    expect(fake.listCalls).toContain('acme')
    expect((await searchInviteCandidates('dana', [])).map((c) => c.name)).toEqual(['Dana Whitfield'])
  })

  it('installs once: a replayed callback finds nothing', async () => {
    const started = await start()
    expect((await returnFrom(started.url)).status).toBe(200)
    const replay = await returnFrom(started.url)
    expect(replay.status).toBe(400)
    expect(await replay.text()).toContain('Install expired')
    expect(await handle.db.select().from(teamDirectories).all()).toHaveLength(1)
  })

  it('lets a declined install be tried again from the same page', async () => {
    const started = await start()
    const declined = await returnFrom(started.url, { error: 'access_denied' })
    expect(declined.status).toBe(400)
    expect(await declined.text()).toContain('Install cancelled')
    expect(await status(started.installId)).toMatchObject({ status: 'cancelled', at: expect.any(Number) })
    expect(fake.provisioner.calls.map((c) => c.op)).toEqual(['create-directory'])

    expect((await returnFrom(started.url)).status).toBe(200)
    expect(await status(started.installId)).toMatchObject({ status: 'connected' })
  })

  it('deletes the app and says why when the install can’t connect the directory', async () => {
    const started = await start()
    vi.spyOn(fake.provider, 'verify').mockRejectedValueOnce(new DirectoryConnectError('The fake workspace is closed'))
    const back = await returnFrom(started.url)
    expect(back.status).toBe(400)
    expect(await back.text()).toContain('The fake workspace is closed')
    expect(await status(started.installId)).toEqual({ status: 'failed', error: 'The fake workspace is closed' })
    expect(await handle.db.select().from(teamDirectories).all()).toEqual([])
    await backgroundSettled()
    expect(fake.provisioner.calls.at(-1)).toEqual({ op: 'delete', detail: { appId: 'DIR1' } })
  })

  it('refuses a bad token, and says to start again when the app can’t be made', async () => {
    const bad = await post('/install', { provider: 'fake', credentials: { key: 'bad' } })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'That key is no good' })

    fake.provisioner.failCreate(new Error('The fake provider is down'))
    const failed = await post('/install', { provider: 'fake', credentials: { key: 'admin-key' } })
    expect(failed.status).toBe(400)
    expect(await failed.json()).toEqual({ error: 'Fake Directory did not create the app. Generate a new token and try again.' })
  })

  it('refuses a provider that can’t be connected this way', async () => {
    const plain = createFakeDirectoryProvider('plain', 'Plain Directory')
    const unregisterPlain = registerDirectoryProvider(plain.provider)
    try {
      const refused = await post('/install', { provider: 'plain', credentials: { key: 'admin-key' } })
      expect(refused.status).toBe(400)
      expect(await refused.json()).toEqual({ error: 'Plain Directory can’t be connected with a token alone.' })
    } finally {
      unregisterPlain()
    }
  })

  it('is started and watched by admins only; the callback needs no session', async () => {
    expect((await post('/install', { provider: 'fake', credentials: { key: 'admin-key' } }, 'member')).status).toBe(403)
    const started = await start()
    expect((await call(`/install/${started.installId}`, { as: 'member' })).status).toBe(403)
    expect(await status('unknown')).toEqual({ status: 'expired' })
  })

  it('deletes the app Gamut made with the directory, and the one it replaces', async () => {
    const first = await start()
    await returnFrom(first.url)
    // The same workspace connected again: the new app replaces the old one.
    const second = await start('admin-key-2')
    await returnFrom(second.url)
    await backgroundSettled()
    expect(fake.provisioner.calls.filter((c) => c.op === 'delete')).toEqual([{ op: 'delete', detail: { appId: 'DIR1' } }])

    const [row] = await handle.db.select().from(teamDirectories).all()
    const disconnected = await call(`/${row.id}`, { method: 'DELETE' })
    expect(await disconnected.json()).toEqual({ appLeftBehind: false })
    await backgroundSettled()
    expect(fake.provisioner.calls.filter((c) => c.op === 'delete')).toEqual([
      { op: 'delete', detail: { appId: 'DIR1' } },
      { op: 'delete', detail: { appId: 'DIR2' } },
    ])
  })
})
