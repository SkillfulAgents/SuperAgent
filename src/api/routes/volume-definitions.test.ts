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
  it('browses workspace folders with authentication, omitting files and rejecting invalid folders', async () => {
    fs.mkdirSync(path.join(folder, 'Reports'))
    fs.mkdirSync(path.join(folder, 'Research'))
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'A file, not a folder')
    const route = `/folders?path=${encodeURIComponent(folder)}`
    expect((await app.request(`/volumes${route}`)).status).toBe(401)
    const response = await request(route)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      path: folder, parent: path.dirname(folder),
      folders: [
        { name: 'Reports', path: path.join(folder, 'Reports') },
        { name: 'Research', path: path.join(folder, 'Research') },
      ],
    })
    expect((await request('/folders?path=relative')).status).toBe(400)
    expect((await request(`/folders?path=${encodeURIComponent(path.join(folder, 'missing'))}`)).status).toBe(400)
    expect((await request(`/folders?path=${encodeURIComponent(path.join(folder, 'notes.txt'))}`)).status).toBe(400)
    const root = path.parse(folder).root
    expect(await (await request(`/folders?path=${encodeURIComponent(root)}`)).json()).toMatchObject({ path: root, parent: null })
  })
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
