import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, agentVolumes, volumeDefinitions } from '@shared/lib/db/schema'
import { addMount, attachMount, getMounts, getMountsWithHealth, listVolumes, removeMount, resolveVolume, volumeSummary } from './mount-service'
import { updateVolumeDefinition } from './volume-service'

let handle: TestDatabase
let tmpDir: string
const viewer = { userId: null, admin: true }
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mount-service-test-')))
  handle = await createTestDatabase()
  await handle.db.insert(agents).values(['test-agent', 'agent-b'].map(slug => ({ slug, name: slug, createdAt: new Date() }))).run()
})
afterEach(async () => {
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
    expect(mount).toEqual({ id: expect.any(String), volumeId: expect.any(String), name: 'myapp', type: 'local', config: { path: hostPath } })
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
    expect((await volume!.list('')).map(entry => entry.name)).toEqual(['a.txt'])
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
    expect(await getMounts('test-agent')).toEqual([original])
    expect((await attachMount('agent-b', original.volumeId, viewer)).name).toBe('renamed')
    expect((await listVolumes('test-agent')).volumes).toEqual([{ volumeId: original.id, name: 'notes', cacheMode: 'local' }])
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
    expect((await listVolumes('test-agent')).volumes).toContainEqual({ volumeId: spaces.id, name: '   ', cacheMode: 'local' })
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
      volumes: [{ volumeId: 'v1', name: 'notes', cacheMode: 'local' }],
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
