import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agentAcl, agents, agentVolumes, user, volumeDefinitions } from '@shared/lib/db/schema'
import { addMount, applyMyAgentDrives, listMyAgentSlugs, setMyAgentDrive, attachMount, getMounts, getMountsWithHealth, listVolumes, removeMount, resolveVolume, setMountReadOnly, volumeSummary } from './mount-service'
import { getUserSettings, updateUserSettings } from './user-settings-service'
import { serializeByKey } from '@shared/lib/utils/keyed-queue'
import { updateVolumeDefinition } from './volume-service'

let handle: TestDatabase
let tmpDir: string
const viewer = { userId: null, admin: true }
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
const authMode = vi.hoisted(() => ({ on: false }))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => authMode.on }))

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mount-service-test-')))
  handle = await createTestDatabase()
  await handle.db.insert(agents).values(['test-agent', 'agent-b'].map(slug => ({ slug, name: slug, createdAt: new Date() }))).run()
})
afterEach(async () => {
  authMode.on = false
  await handle.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
function folder(name: string): string {
  const dir = path.join(tmpDir, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
const add = (hostPath: string) => addMount('test-agent', 'local', { path: hostPath }, viewer)
async function storedMount(id: string, name: string, config: unknown, type = 'local') {
  await handle.db.insert(volumeDefinitions).values({ id, name, type, config: JSON.stringify(z.json().parse(config)), createdAt: new Date(), updatedAt: new Date() }).run()
  await handle.db.insert(agentVolumes).values({ id, name, agentSlug: 'test-agent', volumeId: id, createdAt: new Date() }).run()
}

describe('SQLite mount attachments', () => {
  it('starts empty and persists definitions separately from attachments', async () => {
    expect(await getMounts('test-agent')).toEqual([])
    const hostPath = folder('myapp')
    const mount = await add(hostPath)
    expect(mount).toEqual({ id: expect.any(String), volumeId: expect.any(String), name: 'myapp', volumeName: 'myapp', type: 'local', config: { path: hostPath }, readOnly: false })
    expect(mount.volumeId).not.toBe(mount.id)
    expect(await getMounts('test-agent')).toEqual([mount])
    expect(await handle.db.select().from(volumeDefinitions).all()).toHaveLength(1)
    expect(await handle.db.select().from(agentVolumes).all()).toHaveLength(1)
    expect(volumeSummary(mount)).toEqual({ id: mount.id, name: 'myapp', type: 'local', hostPath })
  })
  it('allocates unique mount paths and fills a suffix freed by detaching', async () => {
    const mounts = []
    for (const prefix of ['a', 'b', 'c']) mounts.push(await add(folder(`${prefix}/project`)))
    expect(mounts.map(m => m.name)).toEqual(['project', 'project-2', 'project-3'])
    await removeMount('test-agent', mounts[1].id)
    expect((await add(folder('d/project'))).name).toBe('project-2')
  })
  it('shares one source across agents with separate grants and attachment IDs', async () => {
    const hostPath = folder('notes')
    fs.writeFileSync(path.join(hostPath, 'a.txt'), 'shared content')
    const a = await add(hostPath)
    const b = await attachMount('agent-b', a.volumeId, viewer)
    expect(b.volumeId).toBe(a.volumeId)
    expect(b.id).not.toBe(a.id)
    expect(await handle.db.select().from(volumeDefinitions).all()).toHaveLength(1)
    const volume = await resolveVolume('agent-b', b.id)
    expect((await volume!.ops.list('')).map(entry => entry.name)).toEqual(['a.txt'])
    expect(await resolveVolume('agent-b', a.id)).toBeNull()
    expect(await resolveVolume('test-agent', a.volumeId)).toBeNull()
    expect(await resolveVolume('test-agent', 'unknown')).toBeNull()
    await removeMount('test-agent', a.id)
    expect(await resolveVolume('test-agent', a.id)).toBeNull()
    expect(await resolveVolume('agent-b', b.id)).not.toBeNull()
    expect(await handle.db.select().from(volumeDefinitions).all()).toHaveLength(1)
  })
  it('keeps mount paths and URLs when a definition is renamed', async () => {
    const original = await add(folder('notes'))
    await updateVolumeDefinition(original.volumeId, { name: 'renamed' }, viewer)
    expect(await getMounts('test-agent')).toEqual([{ ...original, volumeName: 'renamed' }])
    expect((await getMountsWithHealth('test-agent')).map(m => [m.name, m.volumeName])).toEqual([['notes', 'renamed']])
    expect((await attachMount('agent-b', original.volumeId, viewer)).name).toBe('renamed')
    expect((await listVolumes('test-agent')).volumes).toEqual([{ volumeId: original.id, name: 'notes', volumeName: 'renamed', cacheMode: 'local' }])
  })
  it('sets read only on one attachment, and every reader of it agrees', async () => {
    const mount = await add(folder('team'))
    await attachMount('agent-b', mount.volumeId, viewer)
    expect(mount.readOnly).toBe(false)
    expect(await setMountReadOnly('test-agent', mount.id, true)).toBe(true)
    expect(await setMountReadOnly('agent-b', mount.id, true)).toBe(false)
    expect((await listVolumes('test-agent')).volumes).toEqual([{ volumeId: mount.id, name: 'team', volumeName: 'team', cacheMode: 'local', readOnly: true }])
    expect((await getMountsWithHealth('test-agent'))[0].readOnly).toBe(true)
    expect((await resolveVolume('test-agent', mount.id))?.readOnly).toBe(true)
    expect((await getMountsWithHealth('agent-b'))[0].readOnly).toBe(false)
    expect(await setMountReadOnly('test-agent', mount.id, false)).toBe(true)
    expect((await listVolumes('test-agent')).volumes[0]).not.toHaveProperty('readOnly')
  })
  it('detaches only the specified mount and preserves sources and files', async () => {
    const a = await add(folder('keep'))
    const b = await add(folder('detach'))
    await removeMount('agent-b', a.id)
    await removeMount('test-agent', 'unknown')
    await removeMount('test-agent', b.id)
    expect(await getMounts('test-agent')).toEqual([a])
    expect(await handle.db.select().from(volumeDefinitions).all()).toHaveLength(2)
    expect(fs.existsSync(path.join(tmpDir, 'detach'))).toBe(true)
  })
  it('validates source type, configuration, folder and name before storing', async () => {
    const hostPath = folder('valid')
    for (const type of ['gdrive', 'toString']) await expect(addMount('test-agent', type, {}, viewer)).rejects.toThrow('Unknown volume type')
    await expect(addMount('test-agent', 'local', { folder: hostPath }, viewer)).rejects.toThrow('Invalid volume config')
    await expect(add('relative/path')).rejects.toThrow('absolute path')
    await expect(add(path.join(tmpDir, 'absent'))).rejects.toThrow()
    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content')
    await expect(add(path.join(tmpDir, 'file.txt'))).rejects.toThrow('directory')
    await expect(add(path.parse(tmpDir).root)).rejects.toThrow('The folder must have a name')
    await expect(addMount('test-agent', 'local', { path: hostPath }, viewer, { name: '../outside' })).rejects.toThrow()
    expect(await handle.db.select().from(volumeDefinitions).all()).toEqual([])
  })
  it('canonicalizes symlinks and accepts spaces in a folder name', async () => {
    const real = folder('real')
    const link = path.join(tmpDir, 'link')
    fs.symlinkSync(real, link)
    expect((await add(link)).config).toEqual({ path: real })
    const spaces = await add(folder('   '))
    expect((await listVolumes('test-agent')).volumes).toContainEqual({ volumeId: spaces.id, name: '   ', volumeName: '   ', cacheMode: 'local' })
  })
})

describe('volume health and stored configuration', () => {
  it('keeps container startup and UI health in agreement', async () => {
    const notes = folder('notes')
    await storedMount('v1', 'notes', { path: notes })
    await storedMount('v2', 'gone', { path: path.join(tmpDir, 'gone') })
    await storedMount('v3', 'bad', { folder: notes })
    await storedMount('v4', '', { path: notes })
    expect(await listVolumes('test-agent')).toEqual({
      volumes: [{ volumeId: 'v1', name: 'notes', volumeName: 'notes', cacheMode: 'local' }],
      notMounted: [{ name: 'gone', reason: 'not found' }, { name: 'bad', reason: 'unreadable' }, { name: '', reason: 'invalid name' }],
    })
    expect((await getMountsWithHealth('test-agent')).map(m => m.health)).toEqual(['ok', 'missing', 'missing', 'missing'])
  })
  it('reports a deleted folder or a root replaced by a symlink as missing', async () => {
    const dir = folder('replaced')
    await add(dir)
    fs.renameSync(dir, `${dir}-real`)
    fs.symlinkSync(`${dir}-real`, dir)
    expect((await getMountsWithHealth('test-agent'))[0].health).toBe('missing')
    fs.unlinkSync(dir)
    expect((await getMountsWithHealth('test-agent'))[0].health).toBe('missing')
  })
  it.skipIf(process.getuid?.() === 0)('reports a folder the app cannot reach as not accessible', async () => {
    const parent = folder('locked')
    const inner = folder('locked/inner')
    await add(inner)
    fs.chmodSync(parent, 0)
    try {
      expect((await listVolumes('test-agent')).notMounted).toEqual([{ name: 'inner', reason: 'not accessible' }])
    } finally { fs.chmodSync(parent, 0o755) }
  })
  it('preserves unknown sources and reserved names, and permits detaching them', async () => {
    await storedMount('future', 'notes', { folderId: 'x' }, 'future-type')
    expect(await getMounts('test-agent')).toEqual([])
    expect((await add(folder('notes'))).name).toBe('notes-2')
    await expect(attachMount('agent-b', 'future', viewer)).rejects.toThrow('unavailable')
    await removeMount('test-agent', 'future')
    expect(await handle.db.select().from(volumeDefinitions).where(eq(volumeDefinitions.id, 'future')).get()).toBeDefined()
  })
  it('handles invalid JSON without granting access or destroying the record', async () => {
    await storedMount('bad', 'bad', {})
    await handle.db.update(volumeDefinitions).set({ config: '{broken' }).where(eq(volumeDefinitions.id, 'bad')).run()
    expect((await getMountsWithHealth('test-agent'))[0]).toMatchObject({ health: 'missing', hostPath: null })
    expect(await resolveVolume('test-agent', 'bad')).toBeNull()
    await removeMount('test-agent', 'bad')
    expect(await getMounts('test-agent')).toEqual([])
  })
})

describe('add to all my agents', () => {
  const owner = { userId: 'u1', admin: false }
  /** slug → member ids, `id:user` for a non-owner member. */
  async function seedMembers(members: Record<string, string[]>) {
    authMode.on = true
    await handle.db.insert(agents).values(['agent-c', 'agent-d'].map(slug => ({ slug, name: slug, createdAt: new Date() }))).run()
    for (const id of ['u1', 'u2']) await handle.db.insert(user).values({ id, name: id, email: `${id}@example.test` }).run()
    for (const [slug, ids] of Object.entries(members)) {
      for (const member of ids) {
        const [id, role = 'owner'] = member.split(':') as [string, 'owner' | 'user' | 'viewer']
        await handle.db.insert(agentAcl).values({ id: `${slug}-${id}`, userId: id, agentSlug: slug, role, createdAt: new Date() }).run()
      }
    }
  }
  const readOnlyOn = async (slug: string, volumeId: string) => (await getMounts(slug)).find(m => m.volumeId === volumeId)?.readOnly

  it('sets the level on every private agent, replacing hand-set access, and skips shared agents', async () => {
    const drive = await add(folder('brain'))
    await seedMembers({ 'test-agent': ['u1'], 'agent-b': ['u1', 'u2'], 'agent-c': ['u1'], 'agent-d': ['u1:viewer'] })
    const mine = await listMyAgentSlugs('u1', false)
    expect(mine.sort()).toEqual(['agent-c', 'test-agent'])
    for (const slug of mine) await setMyAgentDrive(slug, drive.volumeId, 'read', owner)
    expect(await readOnlyOn('test-agent', drive.volumeId)).toBe(true)
    expect(await readOnlyOn('agent-c', drive.volumeId)).toBe(true)
    expect(await getMounts('agent-b')).toEqual([])
  })

  it('adds a drive read-only in one write', async () => {
    const drive = await add(folder('ro'))
    expect((await attachMount('agent-b', drive.volumeId, viewer, true)).readOnly).toBe(true)
  })

  it('with shared, reaches shared agents I own but never ones I am only a member of', async () => {
    await seedMembers({ 'test-agent': ['u1'], 'agent-b': ['u1', 'u2'], 'agent-c': ['u2', 'u1:user'] })
    expect((await listMyAgentSlugs('u1', true)).sort()).toEqual(['agent-b', 'test-agent'])
  })

  it('reports created, updated, then nothing when the level already holds', async () => {
    const drive = await add(folder('levels'))
    await seedMembers({ 'agent-c': ['u1'] })
    expect(await setMyAgentDrive('agent-c', drive.volumeId, 'write', owner)).toBe('created')
    expect(await setMyAgentDrive('agent-c', drive.volumeId, 'read', owner)).toBe('updated')
    expect(await setMyAgentDrive('agent-c', drive.volumeId, 'read', owner)).toBeNull()
  })

  it('on an agent with two owners, applies only the drives set for shared agents', async () => {
    const privateOnly = await add(folder('private-only'))
    const shared = await add(folder('shared'))
    await seedMembers({ 'agent-b': ['u1', 'u2'] })
    await updateUserSettings('u1', { myAgentDrives: { [privateOnly.volumeId]: { level: 'read', shared: false }, [shared.volumeId]: { level: 'read', shared: true } } })
    await applyMyAgentDrives('agent-b', owner)
    expect((await getMounts('agent-b')).map(m => m.volumeId)).toEqual([shared.volumeId])
  })

  it('a new agent waits for a change already in progress and gets the new level', async () => {
    const drive = await add(folder('ordered'))
    await seedMembers({ 'agent-c': ['u1'] })
    await updateUserSettings('u1', { myAgentDrives: { [drive.volumeId]: { level: 'write', shared: false } } })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const change = serializeByKey('my-agents:u1', async () => {
      await held
      await updateUserSettings('u1', { myAgentDrives: { [drive.volumeId]: { level: 'read', shared: false } } })
    })
    const created = applyMyAgentDrives('agent-c', owner)
    release()
    await Promise.all([change, created])
    expect(await readOnlyOn('agent-c', drive.volumeId)).toBe(true)
  })

  it('gives a new agent the saved drives and skips one that no longer exists', async () => {
    const drive = await add(folder('notes'))
    await seedMembers({ 'agent-c': ['u1'] })
    await updateUserSettings('u1', { myAgentDrives: { [drive.volumeId]: { level: 'write', shared: false }, gone: { level: 'read', shared: false } } })
    await applyMyAgentDrives('agent-c', owner)
    expect(await readOnlyOn('agent-c', drive.volumeId)).toBe(false)
    await updateUserSettings('u1', { myAgentDrives: { gone: null } })
    expect((await getUserSettings('u1')).myAgentDrives).toEqual({ [drive.volumeId]: { level: 'write', shared: false } })
  })
})
