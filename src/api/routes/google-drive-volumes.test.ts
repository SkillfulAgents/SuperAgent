import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { eq } from 'drizzle-orm'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, connectedAccounts, user, proxyAuditLog, volumeDefinitions } from '@shared/lib/db/schema'

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
let exportCache: GoogleDriveExportCache
vi.mock('@shared/lib/volumes/google-drive-export-cache', async importOriginal => ({ ...await importOriginal<object>(), get googleDriveExportCache() { return exportCache } }))
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
import { attachMount, listVolumes } from '@shared/lib/services/mount-service'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { DriveExportTooLargeError, driveRequest, driveUpload } from '@shared/lib/volumes/google-drive-client'
import { googleDriveListingCache } from '@shared/lib/volumes/google-drive-mountable-volume'
import { GoogleDriveExportCache } from '@shared/lib/volumes/google-drive-export-cache'
const app = new Hono().route('/api/volume-definitions', definitions).route('/api/volumes', volumes)
const at = '2026-10-07T12:00:00Z'
const root = { id: 'team', name: 'Team', mimeType: 'application/vnd.google-apps.folder', modifiedTime: at }
const sub = { id: 'sub', name: 'Sub', mimeType: 'application/vnd.google-apps.folder', modifiedTime: at }
const file = { id: 'notes', name: 'notes.txt', mimeType: 'text/plain', size: '11', modifiedTime: at }
const doc = { id: 'doc1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: at }
const config = { accountId: 'drive', folderId: 'team', folderName: 'Client name', driveName: 'Client drive' }

function create(caller = 'alice', body: unknown = { type: 'googledrive', config, name: 'Team' }) {
  return app.request('/api/volume-definitions', { method: 'POST', headers: { 'Test-User': caller, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
function browse(caller: string, query: Record<string, string> = { accountId: 'drive' }) {
  return app.request(`/api/volume-definitions/googledrive/folders?${new URLSearchParams(query)}`, { headers: { 'Test-User': caller } })
}
function dav(id: string, path = '', method = 'PROPFIND', agent = 'agent-a', body?: string) {
  return app.request(`/api/volumes/${id}/${path}`, { method, headers: { 'Test-Agent': agent, Depth: '1' }, body })
}
const urls = () => forward.mock.calls.map(([call]) => new URL(call.targetUrl))

beforeEach(async () => {
  vi.clearAllMocks()
  googleDriveListingCache.invalidate('drive')
  exportCache = new GoogleDriveExportCache()
  vi.stubEnv('AUTH_MODE', 'true')
  resourceCreator.mockResolvedValue(null)
  handle = await createTestDatabase()
  await handle.db.insert(user).values(['alice', 'bob', 'admin'].map(id => ({ id, name: id, email: `${id}@example.com` }))).run()
  await handle.db.insert(agents).values(['agent-a', 'agent-b'].map(slug => ({ slug, name: slug, createdAt: new Date() }))).run()
  await handle.db.insert(connectedAccounts).values({
    id: 'drive', providerConnectionId: 'connection', toolkitSlug: 'googledrive', displayName: 'Google Drive',
    userId: 'alice', createdAt: new Date(), updatedAt: new Date(),
  }).run()
  forward.mockImplementation(async ({ targetUrl, method }) => {
    const url = new URL(targetUrl)
    if (url.pathname === '/drive/v3/files/root') return Response.json({ ...root, id: 'mydrive', name: 'My Drive' })
    if (url.pathname === '/drive/v3/drives') return Response.json({ drives: [{ id: 'shared1', name: 'Shared drive' }] })
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const parent = /'([^']+)' in parents/.exec(url.searchParams.get('q') ?? '')?.[1]
      const children = parent === 'team' ? [sub, file, doc] : []
      return Response.json({ files: url.searchParams.get('q')?.includes('mimeType') ? children.filter(child => child.mimeType === root.mimeType) : children })
    }
    if (url.pathname === '/drive/v3/files/team') return Response.json(root)
    if (url.pathname === '/drive/v3/files/notes') return new Response('hello world')
    if (url.pathname === '/drive/v3/files/doc1/export') return new Response('# Plan')
    if (url.searchParams.get('upload_id') === 'session') return Response.json({ id: 'new', name: 'x', mimeType: 'application/octet-stream', modifiedTime: at })
    if (url.pathname === '/upload/drive/v3/files') return new Response(null, { headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session' } })
    return Response.json(null)
  })
})
afterEach(async () => { await handle.close(); vi.unstubAllEnvs() })

describe('Google Drive volume access and transport', () => {
  it('lets only the account owner browse, listing My Drive and shared drives at the top and subfolders below', async () => {
    expect((await browse('')).status).toBe(401)
    for (const caller of ['bob', 'admin']) {
      expect((await browse(caller)).status).toBe(404)
      expect((await create(caller)).status).toBe(400)
    }
    expect((await browse('alice', { accountId: 'missing' })).status).toBe(404)
    expect((await browse('alice', { accountId: 'drive', folderId: "x' or 1" })).status).toBe(400)
    expect(forward).not.toHaveBeenCalled()
    expect(await (await browse('alice')).json()).toEqual({ folders: [{ id: 'mydrive', name: 'My Drive' }, { id: 'shared1', name: 'Shared drive' }] })
    expect(await (await browse('alice', { accountId: 'drive', folderId: 'team' })).json()).toEqual({ folders: [{ id: 'sub', name: 'Sub' }] })
    expect(urls().every(url => url.hostname === 'www.googleapis.com' && url.searchParams.get('supportsAllDrives') === 'true')).toBe(true)
    expect(urls().at(-1)?.searchParams.get('includeItemsFromAllDrives')).toBe('true')
  })

  it('stores the folder name Drive returns, mounts in remote mode, and audits only the published changes made for the agent', async () => {
    const created = await create()
    expect(created.status).toBe(201)
    const { id } = await created.json()
    const rows = await handle.db.select().from(volumeDefinitions).all()
    expect(rows).toMatchObject([{ userId: 'alice', type: 'googledrive', name: 'Team' }])
    expect(JSON.parse(rows[0].config)).toEqual({ ...config, folderName: 'Team', driveName: 'My Drive' })
    const mount = await attachMount('agent-a', id, { userId: 'alice', admin: false })
    expect((await listVolumes('agent-a')).volumes).toEqual([{ volumeId: mount.id, name: mount.name, cacheMode: 'remote', ignoreSize: true, dirCacheSeconds: 30 }])
    expect((await dav(mount.id, '', 'PROPFIND', 'agent-b')).status).toBe(403)
    await handle.db.delete(proxyAuditLog).run()
    forward.mockClear()
    const listed = await dav(mount.id)
    expect(listed.status).toBe(207)
    const body = await listed.text()
    expect(body).toContain('notes.txt')
    expect(body).toContain('Plan.md')
    expect(body).toContain('<d:getcontentlength>6</d:getcontentlength>')
    expect(await (await dav(mount.id, 'notes.txt', 'GET')).text()).toBe('hello world')
    expect(await (await dav(mount.id, 'Plan.md', 'GET')).text()).toBe('# Plan')
    expect((await dav(mount.id, 'fresh.txt', 'PUT', 'agent-a', 'changed')).status).toBe(201)
    // The Doc's own name makes a new real file beside it; the Doc is never updated.
    expect((await dav(mount.id, 'Plan', 'PUT', 'agent-a', 'changed')).status).toBe(201)
    expect(forward.mock.calls.some(([call]) => call.method === 'PATCH')).toBe(false)
    // rclone makes the parent folder before every upload. An existing one answers from the cached listing.
    forward.mockClear()
    expect((await dav(mount.id, 'Sub', 'MKCOL')).status).toBe(405)
    expect(forward).not.toHaveBeenCalled()
    expect(policy).not.toHaveBeenCalled()
    expect(resourceCreator).toHaveBeenCalledWith('alice')
    const audit = await handle.db.select().from(proxyAuditLog).all()
    // Two uploads published: reads, exports and upload sessions are not in the agent's trail.
    expect(audit.map(row => [row.method, row.targetPath, row.statusCode])).toEqual([['PUT', 'upload/drive/v3/files', 200], ['PUT', 'upload/drive/v3/files', 200]])
    expect(trackServerEvent).not.toHaveBeenCalled()
    expect(audit.every(row => row.agentSlug === 'agent-a' && row.accountId === 'drive' && row.toolkit === 'googledrive' && row.policyDecision === 'allow')).toBe(true)
    expect(urls().every(url => url.hostname === 'www.googleapis.com')).toBe(true)
    await handle.db.update(connectedAccounts).set({ status: 'expired' }).where(eq(connectedAccounts.id, 'drive')).run()
    forward.mockClear()
    expect((await dav(mount.id)).status).toBe(403)
    expect((await browse('alice')).status).toBe(403)
    expect(forward).not.toHaveBeenCalled()
  })

  it('maps Google errors by cause and accepts upload sessions on www.googleapis.com only', async () => {
    const answer = (status: number, reason?: string) => forward.mockResolvedValueOnce(Response.json({ error: { errors: reason ? [{ reason }] : [] } }, { status }))
    answer(404)
    await expect(driveRequest('drive', { method: 'GET', path: 'drive/v3/files/x' })).rejects.toMatchObject({ code: 'not-found' })
    answer(403, 'insufficientPermissions')
    await expect(driveRequest('drive', { method: 'GET', path: 'drive/v3/files/x' })).rejects.toMatchObject({ code: 'not-accessible' })
    answer(401)
    await expect(driveRequest('drive', { method: 'GET', path: 'drive/v3/files/x' })).rejects.toMatchObject({ code: 'not-accessible' })
    answer(403, 'exportSizeLimitExceeded')
    await expect(driveRequest('drive', { method: 'GET', path: 'drive/v3/files/x/export' })).rejects.toBeInstanceOf(DriveExportTooLargeError)
    // A change that hits an upstream failure is never retried: it may have been applied.
    answer(503)
    const before = forward.mock.calls.length
    const failure = await driveRequest('drive', { method: 'PATCH', path: 'drive/v3/files/x', json: {} }).catch(error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toHaveProperty('code')
    expect(forward.mock.calls.length - before).toBe(1)
    // A rate-limit refusal was not applied, so a change retries it with backoff. A read also retries
    // upstream failures, and gives up after the third try.
    vi.useFakeTimers()
    try {
      answer(429)
      answer(403, 'rateLimitExceeded')
      forward.mockResolvedValueOnce(Response.json({ id: 'x' }))
      const change = driveRequest('drive', { method: 'PATCH', path: 'drive/v3/files/x', json: {} })
      await vi.advanceTimersByTimeAsync(3000)
      expect((await change).ok).toBe(true)
      answer(503)
      forward.mockResolvedValueOnce(Response.json({ id: 'x' }))
      const retried = driveRequest('drive', { method: 'GET', path: 'drive/v3/files/x' })
      await vi.advanceTimersByTimeAsync(3000)
      expect((await retried).ok).toBe(true)
      answer(503); answer(503); answer(503)
      const exhausted = driveRequest('drive', { method: 'GET', path: 'drive/v3/files/x' }).catch(error => error)
      await vi.advanceTimersByTimeAsync(3000)
      expect(await exhausted).toBeInstanceOf(Error)
    } finally {
      vi.useRealTimers()
    }
    forward.mockResolvedValueOnce(new Response(null, { headers: { Location: 'https://evil.example/upload' } }))
    await expect(driveUpload('drive', { method: 'POST', path: 'upload/drive/v3/files', json: { name: 'x' } }, new Blob(['x']).stream())).rejects.toThrow('www.googleapis.com')
    const chunks = new Uint8Array(512 * 1024 + 3).fill(7)
    forward.mockClear()
    await driveUpload('drive', { method: 'POST', path: 'upload/drive/v3/files', json: { name: 'x', parents: ['team'] } }, new Blob([chunks]).stream(), { agentSlug: 'agent-a' })
    const puts = forward.mock.calls.filter(([call]) => call.method === 'PUT').map(([call]) => [call.headers.get('Content-Range'), call.headers.get('Content-Type'), call.body.byteLength])
    expect(puts).toEqual([['bytes 0-524287/*', 'application/octet-stream', 524288], ['bytes 524288-524290/524291', 'application/octet-stream', 3]])
    expect(forward.mock.calls[0][0].headers.get('Content-Type')).toBe('application/json')
    expect(forward.mock.calls[0][0].targetUrl).toContain('uploadType=resumable')
    // A client that gave up never sees the upload finish: no chunk is sent once it aborts.
    forward.mockClear()
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(driveUpload('drive', { method: 'POST', path: 'upload/drive/v3/files', json: { name: 'x' } }, new Blob(['x']).stream(), { signal: cancelled.signal })).rejects.toThrow('cancelled')
    expect(forward.mock.calls.filter(([call]) => call.method === 'PUT')).toHaveLength(0)
  })
})
