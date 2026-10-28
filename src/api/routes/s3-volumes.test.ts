import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, user, volumeDefinitions } from '@shared/lib/db/schema'
import { s3Fixture } from '@shared/lib/volumes/testing/s3-fixture'
let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
vi.mock('@shared/lib/auth/secret', () => ({ getOrCreateAuthSecret: () => 'stable-test-secret-not-a-real-credential' }))
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn() }))
vi.mock('../middleware/auth', () => ({
  Authenticated: (): MiddlewareHandler => async (c, next) => {
    const id = c.req.header('Test-User')
    if (!id) return c.json({ error: 'Unauthorized' }, 401)
    c.set('user' as never, { id, role: id === 'admin' ? 'admin' : 'user' } as never)
    return next()
  },
  IsAgent: (): MiddlewareHandler => async (c, next) => {
    const slug = c.req.header('Test-Agent')
    if (!slug) return c.body(null, 401)
    c.set('agentSlug' as never, slug as never)
    return next()
  },
}))
import definitions from './volume-definitions'
import volumes from './volumes'
import { attachMount, listVolumes } from '@shared/lib/services/mount-service'
const app = new Hono().route('/api/volume-definitions', definitions).route('/api/volumes', volumes)
const viewer = { userId: 'alice', admin: false }
beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  handle = await createTestDatabase()
  await handle.db.insert(user).values(['alice', 'bob', 'admin'].map(id => ({ id, name: id, email: `${id}@example.com` }))).run()
  await handle.db.insert(agents).values(['agent-a', 'agent-b'].map(slug => ({ slug, name: slug, createdAt: new Date() }))).run()
})
afterEach(async () => { await handle.close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const asUser = (id = 'alice') => ({ 'Test-User': id, 'Content-Type': 'application/json' })

describe('S3 definition, scope and WebDAV integration', () => {
  it('seals credentials at rest, returns only summaries, and restricts the mount to its attached agent', async () => {
    const f = s3Fixture()
    const response = await app.request('/api/volume-definitions', { method: 'POST', headers: asUser(), body: JSON.stringify({ type: 's3', config: f.config, name: 'Bucket' }) })
    expect(response.status).toBe(201)
    const { id } = await response.json()
    const stored = await handle.db.select().from(volumeDefinitions).get()
    expect(stored?.userId).toBe('alice')
    expect(stored?.config).toContain('sealed')
    expect(stored?.config).not.toContain(f.config.credentials.secretAccessKey)
    expect(stored?.config).not.toContain(f.config.credentials.accessKeyId)
    const own = await (await app.request('/api/volume-definitions', { headers: asUser() })).text()
    expect(own).toContain('S3 · test-bucket/mounted')
    expect(own).not.toContain('credentials')
    expect(await (await app.request('/api/volume-definitions', { headers: asUser('bob') })).json()).toEqual([])
    expect((await app.request(`/api/volume-definitions/${id}/folders`, { headers: asUser('bob') })).status).toBe(404)
    const mount = await attachMount('agent-a', id, viewer)
    const listed = await listVolumes('agent-a')
    expect(listed.volumes).toEqual([{ volumeId: mount.id, name: 'Bucket', volumeName: 'Bucket', cacheMode: 'remote' }])
    expect(JSON.stringify(listed)).not.toContain('credentials')
    const url = `/api/volumes/${mount.id}/hello.txt`
    expect((await app.request(url, { method: 'PUT', body: 'secret', headers: { 'Test-Agent': 'agent-b' } })).status).toBe(403)
    expect((await app.request(url, { method: 'PUT', body: 'hello S3', headers: { 'Test-Agent': 'agent-a' } })).status).toBe(201)
    expect(Buffer.from(f.bytes('hello.txt')!).toString()).toBe('hello S3')
    expect(await (await app.request(url, { headers: { 'Test-Agent': 'agent-a' } })).text()).toBe('hello S3')
    expect((await app.request(`/api/volume-definitions/${id}/folders`, { headers: asUser() })).status).toBe(200)
    const preview = await app.request(`/api/volume-definitions/${id}/file?path=hello.txt&inline=true`, { headers: asUser() })
    expect(preview.headers.get('content-security-policy')).toBe('sandbox allow-scripts')
    expect(await preview.text()).toBe('hello S3')
  })

  it('enforces live validation server-side when a caller bypasses the dialog', async () => {
    const f = s3Fixture(); f.deny(() => 'AccessDenied')
    const response = await app.request('/api/volume-definitions', { method: 'POST', headers: asUser(), body: JSON.stringify({ type: 's3', config: f.config }) })
    expect(response.status).toBe(400)
    expect(await handle.db.select().from(volumeDefinitions).all()).toEqual([])
    expect(await response.text()).toContain('List objects')
  })

  it('allows public definitions only to admins and never accepts stored ciphertext as input', async () => {
    const f = s3Fixture()
    const body = { type: 's3', config: f.config, visibility: 'public' }
    expect((await app.request('/api/volume-definitions', { method: 'POST', headers: asUser(), body: JSON.stringify(body) })).status).toBe(403)
    expect((await app.request('/api/volume-definitions', { method: 'POST', headers: asUser('admin'), body: JSON.stringify(body) })).status).toBe(201)
    const stored = await handle.db.select().from(volumeDefinitions).get()
    expect(stored?.userId).toBeNull()
    const reused = await app.request('/api/volume-definitions', { method: 'POST', headers: asUser('bob'), body: JSON.stringify({ type: 's3', config: JSON.parse(stored!.config) }) })
    expect(reused.status).toBe(400)
  })
})
