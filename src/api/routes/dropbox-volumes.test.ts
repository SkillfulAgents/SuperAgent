import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, connectedAccounts, user, proxyAuditLog, volumeDefinitions, agentConnectedAccounts } from '@shared/lib/db/schema'

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
const { forward, resourceCreator, policy } = vi.hoisted(() => ({ forward: vi.fn(), resourceCreator: vi.fn(), policy: vi.fn(() => 'block') }))
vi.mock('@shared/lib/account-providers/provider-factory', () => ({ getAccountProviderByName: () => ({ makeApiCall: forward }) }))
vi.mock('@shared/lib/platform-attribution', () => ({
  attribution: { fromResourceCreator: resourceCreator },
  runWithAttribution: (_auth: unknown, callback: () => unknown) => callback(),
}))
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@shared/lib/proxy/policy-resolver', () => ({ resolveApiPolicy: policy }))
vi.mock('../middleware/auth', () => ({
  Authenticated: (): MiddlewareHandler => async (c, next) => {
    const id = c.req.header('Test-User')
    if (!id) return c.json({ error: 'Unauthorized' }, 401)
    c.set('user' as never, { id, role: id === 'admin' ? 'admin' : 'user' } as never)
    return next()
  },
  IsAgent: (): MiddlewareHandler => async (c, next) => {
    const id = c.req.header('Test-Agent')
    if (!id) return c.body(null, 401)
    c.set('agentSlug' as never, id as never)
    return next()
  },
}))
import definitions from './volume-definitions'
import volumes from './volumes'
import { attachMount, listVolumes, removeMount } from '@shared/lib/services/mount-service'
import { dropboxRequest } from '@shared/lib/volumes/dropbox-client'
import { dropboxReadCache } from '@shared/lib/volumes/dropbox-read-cache'
import { dropboxHealthCache } from '@shared/lib/volumes/dropbox-health-cache'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
const app = new Hono().route('/api/volume-definitions', definitions).route('/api/volumes', volumes)
const folder = { '.tag': 'folder', name: 'Team', id: 'id:team' }
const file = { '.tag': 'file', name: 'notes.txt', id: 'id:notes', size: 11, rev: 'abc123', server_modified: '2026-10-07T12:00:00Z' }
const config = { accountId: 'dropbox', path: '/Team' }

function create(caller = 'alice', body: unknown = { type: 'dropbox', config, name: 'Team' }) {
  return app.request('/api/volume-definitions', { method: 'POST', headers: { 'Test-User': caller, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
function browse(caller: string, accountId = 'dropbox', path = '') {
  return app.request(`/api/volume-definitions/dropbox/folders?${new URLSearchParams({ accountId, path })}`, { headers: { 'Test-User': caller } })
}
function dav(id: string, path = '', method = 'PROPFIND', agent = 'agent-a', body?: string) {
  return app.request(`/api/volumes/${id}/${path}`, { method, headers: { 'Test-Agent': agent, Depth: '1' }, body })
}

beforeEach(async () => {
  vi.clearAllMocks()
  dropboxReadCache.invalidate('dropbox')
  dropboxHealthCache.invalidate('dropbox')
  vi.stubEnv('AUTH_MODE', 'true')
  resourceCreator.mockResolvedValue(null)
  handle = await createTestDatabase()
  await handle.db.insert(user).values(['alice', 'bob', 'admin'].map(id => ({ id, name: id, email: `${id}@example.com` }))).run()
  await handle.db.insert(agents).values(['agent-a', 'agent-b'].map(slug => ({ slug, name: slug, createdAt: new Date() }))).run()
  await handle.db.insert(connectedAccounts).values({
    id: 'dropbox', providerConnectionId: 'connection', toolkitSlug: 'dropbox', displayName: 'Dropbox',
    userId: 'alice', createdAt: new Date(), updatedAt: new Date(),
  }).run()
  forward.mockImplementation(async ({ targetUrl, body, headers }) => {
    const args = headers.has('Dropbox-API-Arg') ? JSON.parse(headers.get('Dropbox-API-Arg')) : JSON.parse(new TextDecoder().decode(body))
    if (targetUrl.endsWith('get_metadata')) return Response.json(args.path.endsWith('.txt') ? file : folder)
    if (targetUrl.endsWith('list_folder')) return Response.json({ entries: [folder, file], cursor: 'cursor', has_more: false })
    if (targetUrl.endsWith('download')) return new Response('hello world')
    if (targetUrl.endsWith('upload_session/start')) return Response.json({ session_id: 'session' })
    return Response.json(null)
  })
})
afterEach(async () => { await handle.close(); vi.unstubAllEnvs() })

describe('Dropbox volume access and transport', () => {
  it('passes remote mode to the container and reuses parent metadata during a cold 243-directory walk', async () => {
    const { id } = await (await create()).json()
    const mount = await attachMount('agent-a', id, { userId: 'alice', admin: false })
    expect((await listVolumes('agent-a')).volumes).toEqual([{ volumeId: mount.id, name: mount.name, cacheMode: 'remote', caseInsensitive: true }])
    await handle.db.delete(proxyAuditLog).run()
    const children = Array.from({ length: 242 }, (_, i) => ({ ...folder, name: `sub${i}`, path_lower: `/team/sub${i}` }))
    forward.mockClear()
    forward.mockImplementation(async ({ targetUrl, body }) => {
      if (targetUrl.endsWith('get_metadata')) return Response.json(folder)
      const args = JSON.parse(new TextDecoder().decode(body))
      return Response.json({ entries: args.path === '/Team' ? children : [file], cursor: 'end', has_more: false })
    })
    expect((await dav(mount.id)).status).toBe(207)
    for (const child of children) {
      const response = await dav(mount.id, child.name)
      expect(response.status).toBe(207)
      expect(await response.text()).toContain('notes.txt')
    }
    expect(forward).toHaveBeenCalledTimes(244)
    expect(forward.mock.calls.filter(([call]) => call.targetUrl.endsWith('get_metadata'))).toHaveLength(1)
    expect(await handle.db.select().from(proxyAuditLog).all()).toHaveLength(0)
    // Warming the cache cannot retain the account grant after revocation.
    await handle.db.update(connectedAccounts).set({ status: 'expired' }).where(eq(connectedAccounts.id, 'dropbox')).run()
    expect((await dav(mount.id, 'sub0')).status).toBe(403)
    expect(forward).toHaveBeenCalledTimes(244)
  })

  it('requires authentication and ownership to browse or create, including for admins', async () => {
    expect((await browse('')).status).toBe(401)
    for (const caller of ['bob', 'admin']) {
      expect((await browse(caller)).status).toBe(404)
      expect((await create(caller)).status).toBe(400)
    }
    expect((await browse('alice', 'missing')).status).toBe(404)
    expect((await browse('alice', 'dropbox', '/../outside')).status).toBe(400)
    expect(forward).not.toHaveBeenCalled()
    expect(await (await browse('alice')).json()).toEqual({ folders: [{ name: 'Team', path: '/Team' }] })
    expect((await create()).status).toBe(201)
    const rows = await handle.db.select().from(volumeDefinitions).all()
    expect(rows).toMatchObject([{ userId: 'alice', type: 'dropbox' }])
    expect(JSON.parse(rows[0].config)).toEqual(config)
  })

  it('grants only attached agents scoped WebDAV access and audits the actual agent without account policies', async () => {
    const { id } = await (await create()).json()
    const mount = await attachMount('agent-a', id, { userId: 'alice', admin: false })
    expect((await dav(mount.id, '', 'PROPFIND', 'agent-b')).status).toBe(403)
    expect((await dav(id)).status).toBe(403)
    forward.mockClear()
    const listed = await dav(mount.id)
    expect(listed.status).toBe(207)
    expect(await listed.text()).toContain('notes.txt')
    expect(await (await dav(mount.id, 'notes.txt', 'GET')).text()).toBe('hello world')
    expect((await dav(mount.id, 'notes.txt', 'PUT', 'agent-a', 'changed')).status).toBe(201)
    expect(policy).not.toHaveBeenCalled()
    expect(await handle.db.select().from(agentConnectedAccounts).all()).toEqual([])
    expect(resourceCreator).toHaveBeenCalledWith('alice')
    const audit = await handle.db.select().from(proxyAuditLog).all()
    expect(audit).toMatchObject([{ targetPath: '2/files/upload', statusCode: 200 }])
    expect(audit).toHaveLength(1)
    expect(trackServerEvent).not.toHaveBeenCalled()
    expect(audit.every(row => row.agentSlug === 'agent-a' && row.accountId === 'dropbox' && row.policyDecision === 'allow')).toBe(true)
    expect(forward.mock.calls.every(([call]) => ['api.dropboxapi.com', 'content.dropboxapi.com'].includes(new URL(call.targetUrl).hostname))).toBe(true)
    await removeMount('agent-a', mount.id)
    expect((await dav(mount.id)).status).toBe(403)
  })

  it('lets other users attach an explicitly public volume without gaining general account access', async () => {
    await handle.db.update(connectedAccounts).set({ userId: 'admin' }).where(eq(connectedAccounts.id, 'dropbox')).run()
    const { id } = await (await create('admin', { type: 'dropbox', config, visibility: 'public' })).json()
    const mount = await attachMount('agent-b', id, { userId: 'bob', admin: false })
    expect((await dav(mount.id, '', 'PROPFIND', 'agent-b')).status).toBe(207)
    expect((await browse('bob')).status).toBe(404)
    expect(resourceCreator).toHaveBeenCalledWith('admin')
  })

  it('revokes existing mounts when the account expires or is deleted and reports failed upstream calls', async () => {
    const { id } = await (await create()).json()
    const mount = await attachMount('agent-a', id, { userId: 'alice', admin: false })
    forward.mockResolvedValueOnce(Response.json({ error_summary: 'path/not_found/' }, { status: 409 }))
    expect((await dav(mount.id)).status).toBe(403)
    expect(await handle.db.select().from(proxyAuditLog).all()).toEqual([])
    await handle.db.update(connectedAccounts).set({ status: 'expired' }).where(eq(connectedAccounts.id, 'dropbox')).run()
    forward.mockClear()
    expect((await dav(mount.id)).status).toBe(403)
    expect((await browse('alice')).status).toBe(403)
    expect(forward).not.toHaveBeenCalled()
    await handle.db.delete(connectedAccounts).where(eq(connectedAccounts.id, 'dropbox')).run()
    expect((await dav(mount.id)).status).toBe(403)
    expect(forward).not.toHaveBeenCalled()
  })

  it('passes binary bytes unchanged, escapes Unicode header arguments, and maps Dropbox filesystem errors', async () => {
    const bytes = new Uint8Array([0, 255, 128, 1]).buffer
    await dropboxRequest('dropbox', 'upload_session/finish', { path: '/é/文😀' }, { bytes, agentSlug: 'agent-a' })
    const call = forward.mock.calls[0][0]
    expect(new Uint8Array(call.body)).toEqual(new Uint8Array(bytes))
    expect(call.headers.get('Content-Type')).toBe('application/octet-stream')
    const header = call.headers.get('Dropbox-API-Arg')
    expect(header).toMatch(/^[\x20-\x7e]*$/)
    expect(JSON.parse(header)).toEqual({ path: '/é/文😀' })
    for (const [tag, code] of [['path/not_file/', 'not-a-file'], ['path/not_folder/', 'not-a-directory'], ['path/conflict/folder/', 'already-exists']]) {
      forward.mockResolvedValueOnce(Response.json({ error_summary: tag }, { status: 409 }))
      await expect(dropboxRequest('dropbox', 'get_metadata', { path: '/Team' })).rejects.toMatchObject({ code })
    }
  })
})

describe('Dropbox availability and UI health', () => {
  it.each([
    () => Response.json({}, { status: 503 }),
    () => Response.json({ entries: 'invalid Dropbox response' }),
    () => new Response('invalid JSON'),
  ])('reports Dropbox availability errors in the folder picker, preserving invalid-input errors', async upstream => {
    forward.mockImplementationOnce(async () => upstream())
    const response = await browse('alice')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Dropbox is temporarily unavailable. Please try again.' })
    expect((await browse('alice', 'dropbox', '/../outside')).status).toBe(400)
  })

  it('propagates long Retry-After headers through both the picker and WebDAV', async () => {
    const { id } = await (await create()).json()
    const mount = await attachMount('agent-a', id, { userId: 'alice', admin: false })
    vi.useFakeTimers({ now: 0 })
    try {
      forward.mockImplementationOnce(async () => Response.json({}, { status: 429, headers: { 'Retry-After': '60' } }))
      const picker = await browse('alice')
      expect(picker.status).toBe(429)
      expect(picker.headers.get('Retry-After')).toBe('60')
      expect(await picker.json()).toEqual({ error: 'Dropbox is busy. Please try again shortly.' })
      const response = await dav(mount.id)
      expect(response.status).toBe(429)
      expect(response.headers.get('Retry-After')).toBe('60')
    } finally { vi.useRealTimers() }
  })

  it('returns a download rate limit before committing a successful HTTP status', async () => {
    const { id } = await (await create()).json()
    const mount = await attachMount('agent-a', id, { userId: 'alice', admin: false })
    vi.useFakeTimers({ now: 100_000 })
    try {
      forward.mockResolvedValueOnce(Response.json(file))
        .mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'Retry-After': '60' } }))
      const response = await dav(mount.id, 'notes.txt', 'GET')
      expect(response.status).toBe(429)
      expect(response.headers.get('Retry-After')).toBe('60')
    } finally { vi.useRealTimers() }
  })

  it('coalesces and caches settings health across definitions, expires it, and never caches account authorization', async () => {
    await create()
    await create()
    const list = () => app.request('/api/volume-definitions', { headers: { 'Test-User': 'alice' } })
    forward.mockClear()
    vi.useFakeTimers()
    try {
      expect((await (await list()).json()).map((row: { health: string }) => row.health)).toEqual(['ok', 'ok'])
      await list()
      expect(forward).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(60_001)
      await list()
      expect(forward).toHaveBeenCalledTimes(2)
      await handle.db.update(connectedAccounts).set({ status: 'expired' }).where(eq(connectedAccounts.id, 'dropbox')).run()
      expect((await (await list()).json()).map((row: { health: string }) => row.health)).toEqual(['missing', 'missing'])
      expect(forward).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('retains a failed health result briefly and retries it after recovery', async () => {
    await create()
    const list = () => app.request('/api/volume-definitions', { headers: { 'Test-User': 'alice' } })
    forward.mockClear()
    forward.mockResolvedValueOnce(Response.json({}, { status: 503 }))
    vi.useFakeTimers()
    try {
      expect(await (await list()).json()).toMatchObject([{ health: 'missing' }])
      expect(await (await list()).json()).toMatchObject([{ health: 'missing' }])
      expect(forward).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(5_001)
      expect(await (await list()).json()).toMatchObject([{ health: 'ok' }])
      expect(forward).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
})
