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
import { createFakeDirectoryProvider, type FakeDirectory } from '@shared/lib/team-directory/testing/fake-directory-provider'
import type { RefreshDirectoryResponse, TeamDirectoriesResponse } from '@shared/lib/team-directory/view-schema'

let handle: TestDatabase
let fake: FakeDirectory
let unregister: () => void
const app = new Hono().route('/api/team-directories', routes)

const call = (path: string, init: RequestInit & { as?: string } = {}) => app.request(`/api/team-directories${path === '/' ? '' : path}`, {
  ...init,
  headers: { 'Test-User': init.as ?? 'admin', 'Content-Type': 'application/json', ...init.headers },
})
const post = (path: string, body: unknown, as?: string) => call(path, { method: 'POST', body: JSON.stringify(body), as })

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  handle = await createTestDatabase()
  state.db = handle.db
  const now = new Date()
  await handle.db.insert(user).values({ id: 'admin', name: 'Ada Admin', email: 'ada@acme.test', role: 'admin', createdAt: now, updatedAt: now }).run()
  fake = createFakeDirectoryProvider('fake', 'Fake Directory')
  unregister = registerDirectoryProvider(fake.provider)
  fake.setPeople('acme', [fake.person('acme', 'f1', 'Dana Whitfield', 'dana@acme.test')])
})

afterEach(async () => {
  await backgroundSettled()
  unregister()
  vi.unstubAllEnvs()
  await handle.close()
})

describe('team directory routes', () => {
  it('describes every registered provider, real and fake, the same way', async () => {
    const body = await (await call('/')).json() as TeamDirectoriesResponse
    expect(body.providers.map((p) => p.id)).toEqual(['slack', 'fake'])
    expect(body.providers[0]).toMatchObject({ label: 'Slack', fields: [{ key: 'botToken', secret: true }] })
    expect(body.providers[0].setupLink?.href).toContain('users%3Aread.email')
    expect(body.directories).toEqual([])
  })

  it('is for admins only', async () => {
    expect((await call('/', { as: 'member' })).status).toBe(403)
    expect((await post('/', { provider: 'fake', credentials: { token: 'acme-token' } }, 'member')).status).toBe(403)
  })

  it('tests credentials without saving them', async () => {
    const tested = await post('/test', { provider: 'fake', credentials: { token: 'acme-token' } })
    expect(await tested.json()).toEqual({ tenantName: 'ACME', notices: [] })
    const refused = await post('/test', { provider: 'fake', credentials: { token: 'nope' } })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ error: 'That is not a fake token' })
    expect(await handle.db.select().from(teamDirectories).all()).toEqual([])
  })

  it('connects a directory, keeps its credentials sealed, and lists it straight away', async () => {
    const created = await post('/', { provider: 'fake', credentials: { token: 'acme-token' } })
    expect(created.status).toBe(201)
    const { directory } = await created.json() as { directory: TeamDirectoriesResponse['directories'][number] }
    expect(directory).toMatchObject({ provider: 'fake', providerLabel: 'Fake Directory', tenantName: 'ACME', status: 'active', connectedBy: 'Ada Admin' })

    const [row] = await handle.db.select().from(teamDirectories).all()
    expect(row.credentials).not.toContain('acme-token')
    expect(row.createdByUserId).toBe('admin')
    await backgroundSettled()
    expect(fake.listCalls).toEqual(['acme'])
    expect((await searchInviteCandidates('', [])).map((c) => c.name)).toEqual(['Ada Admin', 'Dana Whitfield'])

    const listed = await (await call('/')).json() as TeamDirectoriesResponse
    expect(JSON.stringify(listed)).not.toContain('acme-token')
    expect(listed.directories).toHaveLength(1)

    const [audit] = await handle.db.select().from(auditLog).all()
    expect(audit).toMatchObject({ object: 'team_directory', action: 'connected', userId: 'admin' })
  })

  it('replaces the credentials when the same workspace is connected again', async () => {
    await post('/', { provider: 'fake', credentials: { token: 'acme-token' } })
    await post('/', { provider: 'fake', credentials: { token: 'acme-token' } })
    const rows = await handle.db.select().from(teamDirectories).all()
    expect(rows.map((r) => r.revision)).toEqual([2])
  })

  it('refuses an unknown provider and malformed credentials', async () => {
    expect(await (await post('/', { provider: 'nope', credentials: {} })).json()).toEqual({ error: 'Unknown directory provider: nope' })
    const malformed = await post('/', { provider: 'slack', credentials: { botToken: 'xoxp-user' } })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'Paste the bot token: it starts with xoxb-' })
  })

  it('refreshes on request: the people it found, or why it could not', async () => {
    const { directory } = await (await post('/', { provider: 'fake', credentials: { token: 'acme-token' } })).json() as { directory: { id: string } }
    await backgroundSettled()
    const ok = await (await post(`/${directory.id}/refresh`, {})).json() as RefreshDirectoryResponse
    expect(ok).toMatchObject({ ok: true, userCount: 1, directory: { status: 'active' } })

    fake.failListings('acme')
    const failed = await (await post(`/${directory.id}/refresh`, {})).json() as RefreshDirectoryResponse
    expect(failed).toMatchObject({ ok: false, error: 'The fake directory is down', directory: { status: 'error', errorMessage: 'The fake directory is down' } })
    expect((await post('/missing/refresh', {})).status).toBe(404)
  })

  it('disconnects a directory, whose people then stop appearing', async () => {
    const { directory } = await (await post('/', { provider: 'fake', credentials: { token: 'acme-token' } })).json() as { directory: { id: string } }
    await backgroundSettled()
    expect(await searchInviteCandidates('dana', [])).toHaveLength(1)
    expect(await (await call(`/${directory.id}`, { method: 'DELETE' })).json()).toEqual({ appLeftBehind: false })
    expect(await searchInviteCandidates('dana', [])).toEqual([])
    expect((await call(`/${directory.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('reports a directory whose provider this build lacks as failing', async () => {
    await post('/', { provider: 'fake', credentials: { token: 'acme-token' } })
    await backgroundSettled()
    unregister()
    const listed = await (await call('/')).json() as TeamDirectoriesResponse
    expect(listed.directories[0]).toMatchObject({ providerLabel: 'fake', status: 'error' })
  })
})
