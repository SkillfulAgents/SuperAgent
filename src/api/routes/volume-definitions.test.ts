import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, user } from '@shared/lib/db/schema'
import { attachMount } from '@shared/lib/services/mount-service'
import { releaseVolume, updateVolumeDefinition } from '@shared/lib/services/volume-service'
import { afterMountChange, changeDrives } from '../lib/mount-change'

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
// One agent's drives can fail to read: the next read of `fail` throws.
const reads = vi.hoisted(() => ({ fail: null as string | null }))
vi.mock('@shared/lib/services/mount-service', async (original) => {
  const actual = await original<typeof import('@shared/lib/services/mount-service')>()
  return { ...actual, getMounts: async (slug: string) => {
    if (reads.fail === slug) { reads.fail = null; throw new Error('unreadable') }
    return actual.getMounts(slug)
  } }
})
// Agents as the container sees them: a running one is marked stale, a stopped one is left alone.
const containers = vi.hoisted(() => ({ running: new Set<string>(), starting: new Set<string>(), stale: new Set<string>(), calls: [] as string[] }))
vi.mock('@shared/lib/agent-actor/registry', () => ({
  agentRegistry: {
    get: (slug: string) => ({
      container: {
        invalidate: async (options?: { restart?: boolean }) => {
          containers.calls.push(slug)
          if (options?.restart) throw new Error('a drive change never restarts an agent itself')
          if (!containers.running.has(slug)) return 'not-running'
          containers.stale.add(slug)
          return 'marked-stale'
        },
      },
    }),
  },
}))
const running = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@shared/lib/agent-actor', () => ({ containerHost: { getAgentIdsHoldingDrives: (options?: { orStarting?: boolean }) => {
  running.read()
  return [...containers.running, ...(options?.orStarting ? containers.starting : [])]
} } }))
const feed = vi.hoisted(() => ({ publish: vi.fn() }))
vi.mock('@shared/lib/notifications/global-feed', () => ({ globalFeed: feed }))
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
  containers.running.clear()
  containers.starting.clear()
  containers.stale.clear()
  containers.calls.length = 0
  feed.publish.mockClear()
  running.read.mockClear()
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
  it('chooses a local drive’s folder again in place, for its manager only', async () => {
    const { logAuditEvent } = await import('@shared/lib/services/audit-log-service')
    const { id } = await (await request('', 'POST', input())).json()
    await attachMount('agent', id, { userId: 'alice', admin: false })
    const response = await request(`/${id}/reconnect`, 'POST', { path: folder })
    expect(response.status).toBe(200)
    expect(logAuditEvent).toHaveBeenLastCalledWith({ userId: 'alice', object: 'volume', objectId: id, action: 'updated' })
    expect(await (await request()).json()).toMatchObject([{ id, attachmentCount: 1, health: 'ok' }])
    expect((await request(`/${id}/reconnect`, 'POST', { path: folder }, 'bob')).status).toBe(404)
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'volume-api-other-')))
    try {
      const refused = await request(`/${id}/reconnect`, 'POST', { path: other })
      expect(refused.status).toBe(400)
      expect(await refused.json()).toEqual({ error: `Choose this drive’s own folder, ${folder}. Add another folder as a new drive.` })
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
    expect((await request(`/${id}/reconnect`, 'POST', { path: folder, name: 'x' })).status).toBe(400)
    expect((await request(`/${id}/reconnect`, 'POST', { path: 7 })).status).toBe(400)
  })
  it('marks the running agents that have the drive stale once its folder is chosen again, and only then', async () => {
    await handle.db.insert(agents).values(['stopped', 'other'].map(slug => ({ slug, name: slug, createdAt: new Date() }))).run()
    const { id } = await (await request('', 'POST', input())).json()
    await attachMount('agent', id, { userId: 'alice', admin: false })
    await attachMount('stopped', id, { userId: 'alice', admin: false })
    containers.running = new Set(['agent', 'other'])

    // A refused pick changes nothing, so no agent is told to restart.
    expect((await request(`/${id}/reconnect`, 'POST', { path: folder }, 'bob')).status).toBe(404)
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'volume-api-other-')))
    try {
      expect((await request(`/${id}/reconnect`, 'POST', { path: other })).status).toBe(400)
    } finally {
      fs.rmSync(other, { recursive: true, force: true })
    }
    expect(containers.calls).toEqual([])

    expect((await request(`/${id}/reconnect`, 'POST', { path: folder })).status).toBe(200)
    expect(containers.calls).toEqual(['agent'])
    expect([...containers.stale]).toEqual(['agent'])
  })
  it('marks every running agent stale for a global drive, attached or not', async () => {
    await handle.db.insert(agents).values(['other', 'stopped'].map(slug => ({ slug, name: slug, createdAt: new Date() }))).run()
    const { id } = await (await request('', 'POST', { ...input(), visibility: 'public' }, 'admin')).json()
    expect((await request(`/${id}`, 'PATCH', { global: 'read' }, 'admin')).status).toBe(200)
    containers.calls.length = 0
    containers.running = new Set(['agent', 'other'])
    expect((await request(`/${id}/reconnect`, 'POST', { path: folder }, 'admin')).status).toBe(200)
    expect(containers.calls.sort()).toEqual(['agent', 'other'])
    expect([...containers.stale].sort()).toEqual(['agent', 'other'])
  })
  it('marks only the running agents whose drives a change alters, and tells every client', async () => {
    await handle.db.insert(agents).values({ slug: 'other', name: 'other', createdAt: new Date() }).run()
    const { id } = await (await request('', 'POST', { ...input(), visibility: 'public' }, 'admin')).json()
    await attachMount('agent', id, { userId: 'admin', admin: true })
    containers.running = new Set(['agent', 'other'])

    // A refused change reads no agent's drives.
    expect((await request(`/${id}`, 'PATCH', { name: 'Stolen' }, 'bob')).status).toBe(404)
    expect((await request(`/${id}`, 'DELETE', undefined, 'bob')).status).toBe(404)
    expect(running.read).not.toHaveBeenCalled()
    expect((await request(`/${id}`, 'PATCH', { name: 'Notes', visibility: 'public' }, 'admin')).status).toBe(200)
    expect(containers.calls).toEqual([])
    expect((await request(`/${id}`, 'PATCH', { name: 'Team notes' }, 'admin')).status).toBe(200)
    expect([...containers.stale]).toEqual(['agent'])
    expect(feed.publish.mock.calls).toEqual([...Array(3).fill([{ type: 'volume_attention_changed' }]), [{ type: 'agent_updated', agentSlug: 'agent' }]])

    // Its own attachment gives `agent` the same mount whether or not the drive is global.
    containers.stale.clear()
    expect((await request(`/${id}`, 'PATCH', { global: 'read' }, 'admin')).status).toBe(200)
    expect([...containers.stale]).toEqual(['other'])
    containers.stale.clear()
    expect((await request(`/${id}`, 'PATCH', { name: 'Shared notes' }, 'admin')).status).toBe(200)
    expect([...containers.stale].sort()).toEqual(['agent', 'other'])
    containers.stale.clear()
    expect((await request(`/${id}`, 'PATCH', { global: null }, 'admin')).status).toBe(200)
    expect([...containers.stale]).toEqual(['other'])
  })
  it('marks every running agent stale when a global drive is deleted', async () => {
    await handle.db.insert(agents).values({ slug: 'stopped', name: 'stopped', createdAt: new Date() }).run()
    const { id } = await (await request('', 'POST', { ...input(), visibility: 'public' }, 'admin')).json()
    expect((await request(`/${id}`, 'PATCH', { global: 'read' }, 'admin')).status).toBe(200)
    containers.running = new Set(['agent'])
    expect((await request(`/${id}`, 'DELETE', undefined, 'admin')).status).toBe(200)
    expect([...containers.stale]).toEqual(['agent'])
    expect(containers.calls).toEqual(['agent'])
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

describe('changeDrives', () => {
  it('compares a start that reads its drives during the change, and marks it only if they changed', async () => {
    const { id } = await (await request('', 'POST', { ...input(), visibility: 'public' }, 'admin')).json()
    await attachMount('agent', id, { userId: 'admin', admin: true })
    const readsDuringChange = async (name: string) => {
      containers.starting = new Set(['agent'])
      await changeDrives(async () => {
        await updateVolumeDefinition(id, { name }, { userId: 'admin', admin: true })
        containers.starting.clear()
        containers.running.add('agent')
      })
      containers.running.clear()
    }
    await readsDuringChange('Notes')
    expect(containers.stale.size).toBe(0)
    await readsDuringChange('Renamed')
    expect([...containers.stale]).toEqual(['agent'])
  })
  it('marks a start that begins during the change, since its drive read is unknown', async () => {
    await changeDrives(async () => { containers.running.add('agent') })
    expect([...containers.stale]).toEqual(['agent'])
  })
  it('marks nothing when the change is refused', async () => {
    containers.running = new Set(['agent'])
    await expect(changeDrives(() => Promise.reject(new Error('conflict')))).rejects.toThrow('conflict')
    expect(containers.calls).toEqual([])
    expect(feed.publish).not.toHaveBeenCalled()
  })
  it('leaves out only the agent whose drives cannot be read, before or after the change', async () => {
    await handle.db.insert(agents).values({ slug: 'other', name: 'other', createdAt: new Date() }).run()
    const { id } = await (await request('', 'POST', { ...input(), visibility: 'public' }, 'admin')).json()
    expect((await request(`/${id}`, 'PATCH', { global: 'read' }, 'admin')).status).toBe(200)
    containers.running = new Set(['agent', 'other'])
    for (const [failBefore, name] of [[true, 'Renamed'], [false, 'Renamed again']] as const) {
      containers.stale.clear()
      if (failBefore) reads.fail = 'agent'
      await changeDrives(async () => {
        await updateVolumeDefinition(id, { name }, { userId: 'admin', admin: true })
        if (!failBefore) reads.fail = 'agent'
      })
      expect([...containers.stale]).toEqual(['other'])
    }
  })
  it('tells every window about an agent\'s own drive change, running or not', async () => {
    await afterMountChange('agent')
    expect(feed.publish.mock.calls).toEqual([[{ type: 'volume_attention_changed' }]])
    expect(containers.stale.size).toBe(0)
  })
})

describe('turning Team Brain off', () => {
  it('marks the running agents that lose the drive, never the Team Brain agent that keeps it', async () => {
    await handle.db.insert(agents).values(['brain', 'reader', 'other'].map(slug => ({ slug, name: slug, createdAt: new Date() }))).run()
    const { id } = await (await request('', 'POST', { ...input(), visibility: 'public' }, 'admin')).json()
    await attachMount('brain', id, { userId: 'admin', admin: true })
    await attachMount('reader', id, { userId: 'admin', admin: true })
    expect((await request(`/${id}`, 'PATCH', { global: 'read' }, 'admin')).status).toBe(200)
    containers.running = new Set(['brain', 'reader', 'other'])

    await changeDrives(() => releaseVolume(id, 'brain'))
    expect([...containers.stale].sort()).toEqual(['other', 'reader'])
  })
})
