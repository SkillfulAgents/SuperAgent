import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { mutateSettings } from '@shared/lib/config/settings'
import { backgroundSettled } from '@shared/lib/background'
import { registerDirectoryProvider } from '@shared/lib/team-directory/registry'
import { createFakeDirectoryProvider } from '@shared/lib/team-directory/testing/fake-directory-provider'
import { saveDirectoryConnection } from '@shared/lib/team-directory/store'
import { agentAcl, agents, user } from '@shared/lib/db/schema'
import { attachMount, getMountsWithHealth, removeMount, resolveMountPath, resolveVolume, setMountReadOnly } from '@shared/lib/services/mount-service'

let handle: TestDatabase
let folder: string
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
vi.mock('@shared/lib/auth/secret', () => ({ getOrCreateAuthSecret: async () => 'test-drive-invite-secret' }))
vi.mock('@shared/lib/agent-integrations/app-link', () => ({ resolvePublicAppBaseUrl: async () => 'https://gamut.test' }))
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
// Agents as the container sees them: a running one is marked stale, a stopped one is left alone.
const containers = vi.hoisted(() => ({ running: new Set<string>(), stale: new Set<string>(), calls: [] as string[] }))
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
  containers.stale.clear()
  containers.calls.length = 0
  await handle.db.insert(user).values(['alice', 'bob', 'admin'].map(id => ({ id, name: id, email: `${id}@example.com` }))).run()
  await handle.db.insert(agents).values({ slug: 'agent', name: 'Agent', createdAt: new Date() }).run()
})
afterEach(async () => {
  await backgroundSettled()
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
    expect(await (await request()).json()).toMatchObject([{ id, visibility: 'private', canManage: true }])
    expect(await (await request('', 'GET', undefined, 'bob')).json()).toEqual([])
    expect((await request(`/${id}`, 'PATCH', { name: 'Stolen' }, 'bob')).status).toBe(404)
    expect((await request(`/${id}`, 'DELETE', undefined, 'admin')).status).toBe(404)
    expect((await request('', 'POST', { ...input(), userId: 'bob' })).status).toBe(400)
  })
  it('lists public definitions for everyone, with admin-only management', async () => {
    expect((await request('', 'POST', { ...input(), visibility: 'public' })).status).toBe(403)
    const { id } = await (await request('', 'POST', { ...input(), visibility: 'public' }, 'admin')).json()
    expect(await (await request()).json()).toMatchObject([{ id, visibility: 'public', canManage: false }])
    expect((await request(`/${id}`, 'DELETE')).status).toBe(404)
    expect((await request(`/${id}`, 'PATCH', { name: 'Team notes' }, 'admin')).status).toBe(200)
    expect((await request(`/${id}`, 'DELETE', undefined, 'admin')).status).toBe(200)
  })
  it('lets a co-owner manage an attached public drive while reserving visibility changes for admins', async () => {
    const { id } = await (await request('', 'POST', { ...input(), visibility: 'public' }, 'admin')).json()
    await attachMount('agent', id, { userId: 'admin', admin: true })
    expect((await request(`/${id}/access`, 'POST', { userId: 'alice' }, 'admin')).status).toBe(201)
    expect((await request(`/${id}`, 'PATCH', { name: 'Forecasts', visibility: 'public' }, 'alice')).status).toBe(200)
    expect((await request(`/${id}`, 'PATCH', { visibility: 'private' }, 'alice')).status).toBe(403)
    expect(await (await request('', 'GET', undefined, 'bob')).json()).toMatchObject([{ id, visibility: 'public', attachmentCount: 1 }])
    expect((await request(`/${id}`, 'PATCH', { visibility: 'private' }, 'admin')).status).toBe(200)
    expect(await (await request('', 'GET', undefined, 'bob')).json()).toEqual([])
    expect(await (await request('', 'GET', undefined, 'alice')).json()).toMatchObject([{ id, visibility: 'private', canManage: true, attachmentCount: 1 }])
  })
  it('keeps the designated Team Brain drive public through setup and after launch', async () => {
    const { id } = await (await request('', 'POST', { ...input(), visibility: 'public' }, 'admin')).json()
    const drive = { agentSlug: 'agent', volumeId: id }
    await attachMount('agent', id, { userId: 'admin', admin: true })
    for (const designation of [
      { ...drive, status: 'setting-up' as const, setupId: 'setup', step: 'location' as const, location: 'local' as const,
        schedule: 'daily' as const, everyAgent: false, agents: {} }, drive,
    ]) {
      await mutateSettings(settings => { settings.teamBrain = designation }, handle.db)
      const response = await request(`/${id}`, 'PATCH', { visibility: 'private' }, 'admin')
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: 'Team Brain requires a public drive' })
      expect(await (await request()).json()).toMatchObject([{ id, teamBrainDrive: true, visibility: 'public' }])
    }
    await mutateSettings(settings => { delete settings.teamBrain }, handle.db)
    expect((await request(`/${id}`, 'PATCH', { visibility: 'private' }, 'admin')).status).toBe(200)
    // A setup that checked visibility earlier cannot claim the now-private drive.
    await expect(mutateSettings(settings => { settings.teamBrain = drive }, handle.db)).rejects.toThrow()
  })

  it('notifies a directory person exactly once after granting drive ownership', async () => {
    const fake = createFakeDirectoryProvider('fake', 'Demo Directory')
    const unregister = registerDirectoryProvider(fake.provider)
    try {
      fake.setPeople('acme', [fake.person('acme', 'dana', 'Dana', 'dana@acme.test')])
      const { id: directoryId } = await saveDirectoryConnection({ provider: 'fake', tenant: { tenantId: 'acme', tenantName: 'Acme' }, credentials: { token: 'test-token' }, createdByUserId: null })
      const { id } = await (await request('', 'POST', input())).json()
      const body = { directoryRef: { directoryId, remoteId: 'dana' } }
      expect((await request(`/${id}/access`, 'POST', body, 'bob')).status).toBe(404)
      const grant = await request(`/${id}/access`, 'POST', body)
      expect(grant.status).toBe(201)
      const { userId } = await grant.json()
      expect((await request(`/${id}/access`, 'POST', { userId })).status).toBe(409)
      await backgroundSettled()
      expect(fake.sent).toMatchObject([{ user: { remoteId: 'dana' }, message: {
        headline: 'alice shared the drive Notes with you on Gamut.', link: { url: 'https://gamut.test/?join=dana%40acme.test' },
      } }])
    } finally { unregister() }
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
    expect(await (await request()).json()).toMatchObject([{ visibility: 'public', canManage: true }])
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
    expect(containers.calls.sort()).toEqual(['agent', 'stopped'])
    expect([...containers.stale]).toEqual(['agent'])
  })
  it('marks every running agent stale for a global drive, attached or not', async () => {
    await handle.db.insert(agents).values(['other', 'stopped'].map(slug => ({ slug, name: slug, createdAt: new Date() }))).run()
    const { id } = await (await request('', 'POST', { ...input(), visibility: 'public' }, 'admin')).json()
    expect((await request(`/${id}`, 'PATCH', { global: 'read' }, 'admin')).status).toBe(200)
    containers.running = new Set(['agent', 'other'])
    expect((await request(`/${id}/reconnect`, 'POST', { path: folder }, 'admin')).status).toBe(200)
    expect(containers.calls.sort()).toEqual(['agent', 'other', 'stopped'])
    expect([...containers.stale].sort()).toEqual(['agent', 'other'])
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
  it('grants and revokes direct ownership while the agent keeps using its mount', async () => {
    fs.writeFileSync(path.join(folder, 'report'), 'Quarterly forecast')
    const { id } = await (await request('', 'POST', input())).json()
    const alice = { userId: 'alice', admin: false }
    const bob = { userId: 'bob', admin: false }
    const mount = await attachMount('agent', id, alice)
    for (const stranger of ['bob', 'admin']) {
      expect((await request(`/${id}/access/search-users`, 'GET', undefined, stranger)).status).toBe(404)
      expect((await request(`/${id}/access`, 'POST', { userId: stranger }, stranger)).status).toBe(404)
    }
    expect((await request(`/${id}/access`, 'POST', { userId: 'bob', role: 'viewer' })).status).toBe(400)
    expect((await request(`/${id}/access`, 'POST', { userId: 'bob', role: 'owner' })).status).toBe(201)
    expect((await request(`/${id}/access`, 'POST', { userId: 'bob' })).status).toBe(409)
    expect(await (await request('', 'GET', undefined, 'bob')).json()).toMatchObject([{ id, canManage: true, owners: [
      { userId: 'alice', role: 'owner' }, { userId: 'bob', role: 'owner' },
    ] }])
    expect((await request(`/${id}`, 'PATCH', { name: 'Forecasts' }, 'bob')).status).toBe(200)
    expect(await resolveMountPath('agent', '/mounts/Notes/report', bob)).not.toBeNull()
    expect(await setMountReadOnly('agent', mount.id, true, bob)).toBe(true)

    expect((await request(`/${id}/access/bob`, 'DELETE')).status).toBe(200)
    expect(await (await request('', 'GET', undefined, 'bob')).json()).toEqual([])
    expect(await getMountsWithHealth('agent', bob)).toEqual([{ id: mount.id, volumeName: 'Forecasts', restricted: true }])
    expect(await resolveMountPath('agent', '/mounts/Notes/report', bob)).toBeNull()
    expect(await removeMount('agent', mount.id, bob, 'user')).toBe(false)
    expect(await removeMount('agent', mount.id, { userId: 'admin', admin: true }, 'owner')).toBe(false)
    expect(await setMountReadOnly('agent', mount.id, false, bob)).toBe(false)
    await expect(attachMount('agent', id, bob)).rejects.toMatchObject({ status: 404 })
    const runtime = await resolveVolume('agent', mount.id)
    expect(runtime).toMatchObject({ readOnly: true })
    const file = await runtime!.ops.read('report')
    expect(await new Response(await file.stream()).text()).toBe('Quarterly forecast')
    expect((await request(`/${id}/access/alice`, 'DELETE')).status).toBe(409)
    await handle.db.insert(agentAcl).values({ id: 'agent-owner', userId: 'bob', agentSlug: 'agent', role: 'owner', createdAt: new Date() }).run()
    expect(await removeMount('agent', mount.id, bob, 'owner')).toBe(true)
    expect(await (await request('', 'GET', undefined, 'bob')).json()).toEqual([])
  })

  it('keeps an owner under concurrent removals', async () => {
    const { id } = await (await request('', 'POST', input())).json()
    await request(`/${id}/access`, 'POST', { userId: 'bob' })
    const responses = await Promise.all(['alice', 'bob'].map(person => request(`/${id}/access/${person}`, 'DELETE', undefined, person)))
    expect(responses.map(r => r.status).sort()).toEqual([200, 409])
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
