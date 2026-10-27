import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, user } from '@shared/lib/db/schema'
import { attachMount } from '@shared/lib/services/mount-service'

let handle: TestDatabase
let folder: string
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
vi.mock('../middleware/auth', () => ({
  getReadableAgentIds: vi.fn(async () => new Set(['agent'])),
  Authenticated: (): MiddlewareHandler => async (c, next) => {
    const id = c.req.header('Test-User')
    if (!id) return c.json({ error: 'Unauthorized' }, 401)
    c.set('user' as never, { id, role: id === 'admin' ? 'admin' : 'user' } as never)
    return next()
  },
}))
vi.mock('@shared/lib/services/audit-log-service', () => ({ logAuditEvent: vi.fn() }))
import routes from './volume-definitions'
const app = new Hono().route('/volumes', routes)
function request(route = '', method = 'GET', body?: unknown, caller = 'alice') {
  return app.request(`/volumes${route}`, {
    method, headers: { 'Content-Type': 'application/json', 'Test-User': caller },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'volume-api-')))
  handle = await createTestDatabase()
  await handle.db.insert(user).values(['alice', 'bob', 'admin'].map(id => ({ id, name: id, email: `${id}@example.com` }))).run()
  await handle.db.insert(agents).values({ slug: 'agent', name: 'Agent', createdAt: new Date() }).run()
})
afterEach(async () => {
  await handle.close()
  vi.unstubAllEnvs()
  fs.rmSync(folder, { recursive: true, force: true })
})
const input = () => ({ type: 'local', config: { path: folder }, name: 'Notes' })

describe('volume definition API', () => {
  it('requires authentication and binds private ownership to the authenticated user', async () => {
    expect((await app.request('/volumes')).status).toBe(401)
    const response = await request('', 'POST', input())
    expect(response.status).toBe(201)
    const { id } = await response.json()
    expect(await (await request()).json()).toMatchObject([{ id, userId: 'alice', canManage: true }])
    expect(await (await request('', 'GET', undefined, 'bob')).json()).toEqual([])
    expect((await request(`/${id}`, 'PATCH', { name: 'Stolen' }, 'bob')).status).toBe(404)
    expect((await request(`/${id}`, 'DELETE', undefined, 'admin')).status).toBe(404)
    expect((await request('', 'POST', { ...input(), userId: 'bob' })).status).toBe(400)
  })
  it('lists public definitions for everyone, with admin-only management', async () => {
    expect((await request('', 'POST', { ...input(), visibility: 'public' })).status).toBe(403)
    const { id } = await (await request('', 'POST', { ...input(), visibility: 'public' }, 'admin')).json()
    expect(await (await request()).json()).toMatchObject([{ id, userId: null, canManage: false }])
    expect((await request(`/${id}`, 'DELETE')).status).toBe(404)
    expect((await request(`/${id}`, 'PATCH', { name: 'Team notes' }, 'admin')).status).toBe(200)
    expect((await request(`/${id}`, 'DELETE', undefined, 'admin')).status).toBe(200)
  })
  it('rejects deletion while attached and validates malformed requests', async () => {
    const { id } = await (await request('', 'POST', input())).json()
    await attachMount('agent', id, { userId: 'alice', admin: false })
    expect((await request(`/${id}`, 'DELETE')).status).toBe(409)
    expect((await request(`/${id}`, 'PATCH', { name: '../escape' })).status).toBe(400)
    expect((await request('', 'POST', { type: 'local', config: { path: 'relative' } })).status).toBe(400)
    expect((await app.request('/volumes', { method: 'POST', headers: { 'Test-User': 'alice' }, body: '{broken' })).status).toBe(400)
  })
  it('defaults to a public definition in non-authenticated deployments', async () => {
    vi.stubEnv('AUTH_MODE', 'false')
    expect((await request('', 'POST', input())).status).toBe(201)
    expect(await (await request()).json()).toMatchObject([{ userId: null, canManage: true }])
  })
})


describe('volume browsing', () => {
  it('browses a stopped local source, with folders first and exact file names', async () => {
    fs.mkdirSync(path.join(folder, 'Reports'))
    fs.writeFileSync(path.join(folder, 'Reports', 'Q1 # 日本語.txt'), 'Volume preview')
    fs.writeFileSync(path.join(folder, 'a.txt'), 'root')
    const { id } = await (await request('', 'POST', input())).json()
    expect(await (await request(`/${id}/folders`)).json()).toEqual({ root: '', path: '', truncated: false, entries: [
      { name: 'Reports', path: 'Reports', type: 'directory', mtimeMs: expect.any(Number) },
      { name: 'a.txt', path: 'a.txt', type: 'file', mtimeMs: fs.statSync(path.join(folder, 'a.txt')).mtimeMs },
    ] })
    const filePath = encodeURIComponent('Reports/Q1 # 日本語.txt')
    const listing = await request(`/${id}/folders?path=Reports`)
    expect(await listing.json()).toMatchObject({ entries: [{ name: 'Q1 # 日本語.txt', path: 'Reports/Q1 # 日本語.txt' }] })
    const file = await request(`/${id}/file?path=${filePath}&inline=true`)
    expect(file.status).toBe(200)
    expect(await file.text()).toBe('Volume preview')
    expect(file.headers.get('content-type')).toContain('text/plain')
    expect(file.headers.get('cache-control')).toContain('no-store')
    expect(file.headers.get('content-security-policy')).toContain('sandbox')
  })
  it('authorizes each browse, download and attachment request against the definition', async () => {
    fs.writeFileSync(path.join(folder, 'private.txt'), 'Private')
    const { id } = await (await request('', 'POST', input())).json()
    await attachMount('agent', id, { userId: 'alice', admin: false })
    for (const suffix of ['/folders', '/file?path=private.txt', '/agents']) {
      expect((await request(`/${id}${suffix}`, 'GET', undefined, 'bob')).status).toBe(404)
      expect((await request(`/${id}${suffix}`, 'GET', undefined, 'admin')).status).toBe(404)
      expect((await app.request(`/volumes/${id}${suffix}`)).status).toBe(401)
    }
    expect(await (await request(`/${id}/agents`)).json()).toMatchObject({ attachments: [{ agentSlug: 'agent' }] })
  })
  it('serves public sources to other users and hides agents they cannot read', async () => {
    fs.writeFileSync(path.join(folder, 'shared.txt'), 'Shared')
    const { id } = await (await request('', 'POST', { ...input(), visibility: 'public' }, 'admin')).json()
    await handle.db.insert(agents).values({ slug: 'hidden', name: 'Hidden', createdAt: new Date() }).run()
    await attachMount('agent', id, { userId: 'alice', admin: false })
    await attachMount('hidden', id, { userId: 'alice', admin: false })
    expect((await request(`/${id}/folders`, 'GET', undefined, 'bob')).status).toBe(200)
    expect(await (await request(`/${id}/file?path=shared.txt`, 'GET', undefined, 'bob')).text()).toBe('Shared')
    const result = await (await request(`/${id}/agents`, 'GET', undefined, 'bob')).json()
    expect(result.attachments.map((item: { agentSlug: string }) => item.agentSlug)).toEqual(['agent'])
  })
  it('rejects traversal and symlink escapes without reading another source', async () => {
    const { id } = await (await request('', 'POST', input())).json()
    for (const badPath of ['../outside', '/etc/passwd', 'Reports/../../outside', 'Reports/../a', 'a\\b', 'a\0b']) {
      for (const route of ['folders', 'file']) {
        expect((await request(`/${id}/${route}?path=${encodeURIComponent(badPath)}`)).status).toBe(400)
      }
    }
    fs.symlinkSync(os.tmpdir(), path.join(folder, 'escape'))
    expect((await request(`/${id}/folders?path=escape`)).status).toBe(404)
    expect((await request(`/${id}/file?path=escape/anything.txt`)).status).toBe(400)
    expect((await request(`/${id}/file`)).status).toBe(400)
  })
  it('serves ranges and HEAD for previews, and offers original downloads', async () => {
    fs.writeFileSync(path.join(folder, 'clip.mp4'), '0123456789')
    const { id } = await (await request('', 'POST', input())).json()
    const ranged = await app.request(`/volumes/${id}/file?path=clip.mp4&inline=true`, { headers: { 'Test-User': 'alice', Range: 'bytes=2-5' } })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await ranged.text()).toBe('2345')
    const head = await request(`/${id}/file?path=clip.mp4`, 'HEAD')
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')
    const invalid = await app.request(`/volumes/${id}/file?path=clip.mp4`, { headers: { 'Test-User': 'alice', Range: 'bytes=100-200' } })
    expect(invalid.status).toBe(416)
    const download = await request(`/${id}/file?path=clip.mp4`)
    expect(download.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(await download.text()).toBe('0123456789')
  })
})
