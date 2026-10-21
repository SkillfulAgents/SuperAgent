import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, user, volumeDefinitions } from '@shared/lib/db/schema'
import { removeGithubSync } from '@shared/lib/volumes/github-sync'
import { attachMount, removeMount } from './mount-service'
import { createVolumeDefinition, deleteVolumeDefinition, listVolumeDefinitions, releaseVolume, updateVolumeDefinition } from './volume-service'

let handle: TestDatabase
let folder: string
const alice = { userId: 'alice', admin: false }
const bob = { userId: 'bob', admin: false }
const admin = { userId: 'admin', admin: true }
const local = { userId: null, admin: true }
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
beforeEach(async () => {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'volume-access-')))
  vi.stubEnv('SUPERAGENT_DATA_DIR', folder)
  handle = await createTestDatabase()
  await handle.db.insert(user).values(['alice', 'bob', 'admin'].map(id => ({ id, name: id, email: `${id}@example.com` }))).run()
  await handle.db.insert(agents).values({ slug: 'agent', name: 'Agent', createdAt: new Date() }).run()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await removeGithubSync('github-volume')
  await handle.close()
  fs.rmSync(folder, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
const input = () => ({ type: 'local', config: { path: folder }, name: 'Notes' })

describe('volume ownership', () => {
  it('defaults to the creator and never accepts an owner supplied by the client', async () => {
    const id = await createVolumeDefinition(input(), alice)
    expect(await listVolumeDefinitions(alice)).toMatchObject([{ id, userId: 'alice', canManage: true, attachmentCount: 0 }])
    expect(await listVolumeDefinitions(bob)).toEqual([])
    expect(await listVolumeDefinitions(admin)).toEqual([])
    await expect(createVolumeDefinition({ ...input(), userId: 'bob' }, alice)).rejects.toThrow()
    for (const viewer of [bob, admin]) {
      await expect(attachMount('agent', id, viewer)).rejects.toMatchObject({ status: 404 })
      await expect(updateVolumeDefinition(id, { name: 'Stolen' }, viewer)).rejects.toMatchObject({ status: 404 })
      await expect(deleteVolumeDefinition(id, viewer)).rejects.toMatchObject({ status: 404 })
    }
  })
  it('allows everyone to attach public definitions, with management restricted to admins', async () => {
    const id = await createVolumeDefinition({ ...input(), visibility: 'public' }, admin)
    expect(await listVolumeDefinitions(bob)).toMatchObject([{ id, userId: null, canManage: false }])
    expect(await listVolumeDefinitions(admin)).toMatchObject([{ id, canManage: true }])
    expect((await attachMount('agent', id, bob)).volumeId).toBe(id)
    await expect(updateVolumeDefinition(id, { name: 'Renamed' }, bob)).rejects.toMatchObject({ status: 404 })
    await expect(deleteVolumeDefinition(id, bob)).rejects.toMatchObject({ status: 404 })
    await expect(createVolumeDefinition({ ...input(), visibility: 'public' }, bob)).rejects.toMatchObject({ status: 403 })
    const privateId = await createVolumeDefinition(input(), bob)
    await expect(updateVolumeDefinition(privateId, { name: 'Notes', visibility: 'public' }, bob)).rejects.toMatchObject({ status: 403 })
  })
  it('makes only public drives global, and keeps a global drive public until global is off', async () => {
    const privateId = await createVolumeDefinition(input(), alice)
    await expect(updateVolumeDefinition(privateId, { global: 'read' }, alice)).rejects.toMatchObject({ status: 400 })
    const id = await createVolumeDefinition({ ...input(), visibility: 'public' }, admin)
    await expect(updateVolumeDefinition(id, { global: 'read' }, bob)).rejects.toMatchObject({ status: 404 })
    await expect(updateVolumeDefinition(id, { visibility: 'private', global: 'read' }, admin)).rejects.toMatchObject({ status: 400 })
    await updateVolumeDefinition(id, { global: 'write' }, admin)
    expect(await listVolumeDefinitions(bob)).toMatchObject([{ id, globalAccess: 'write' }])
    await expect(updateVolumeDefinition(id, { visibility: 'private' }, admin)).rejects.toMatchObject({ status: 409, message: 'Turn off global before changing access' })
    expect(await listVolumeDefinitions(admin)).toMatchObject([{ id, userId: null, globalAccess: 'write' }])
    await updateVolumeDefinition(id, { global: null }, admin)
    await updateVolumeDefinition(id, { visibility: 'private' }, admin)
    expect(await listVolumeDefinitions(admin)).toMatchObject([{ id, userId: 'admin', globalAccess: null }])
  })
  it('releases a drive from every agent but one and from global, whoever owns it', async () => {
    await handle.db.insert(agents).values([{ slug: 'brain', name: 'Brain', createdAt: new Date() }, { slug: 'reader', name: 'Reader', createdAt: new Date() }]).run()
    const id = await createVolumeDefinition(input(), alice)
    await attachMount('brain', id, alice)
    await attachMount('agent', id, alice)
    await attachMount('reader', id, alice)
    expect((await releaseVolume(id, 'brain')).sort()).toEqual(['agent', 'reader'])
    expect(await listVolumeDefinitions(alice)).toMatchObject([{ id, attachmentCount: 1, globalAccess: null }])
    const shared = await createVolumeDefinition({ ...input(), visibility: 'public' }, admin)
    await updateVolumeDefinition(shared, { global: 'read' }, admin)
    expect(await releaseVolume(shared, 'brain')).toEqual([])
    expect((await listVolumeDefinitions(admin)).find((d) => d.id === shared)).toMatchObject({ globalAccess: null })
  })
  it('deletes a global drive that no agent has as its own', async () => {
    const id = await createVolumeDefinition({ ...input(), visibility: 'public' }, admin)
    await updateVolumeDefinition(id, { global: 'read' }, admin)
    await deleteVolumeDefinition(id, admin)
    expect(await listVolumeDefinitions(admin)).toEqual([])
  })
  it('blocks deletion and changes of scope until attachments are removed, but permits renames', async () => {
    const id = await createVolumeDefinition(input(), admin)
    const mount = await attachMount('agent', id, admin)
    expect(await listVolumeDefinitions(admin)).toMatchObject([{ attachmentCount: 1 }])
    await expect(deleteVolumeDefinition(id, admin)).rejects.toMatchObject({ status: 409 })
    await expect(updateVolumeDefinition(id, { name: 'Notes', visibility: 'public' }, admin)).rejects.toMatchObject({ status: 409 })
    await updateVolumeDefinition(id, { name: 'Renamed', visibility: 'private' }, admin)
    await removeMount('agent', mount.id)
    await updateVolumeDefinition(id, { visibility: 'public' }, admin)
    expect(await listVolumeDefinitions(alice)).toMatchObject([{ id, name: 'Renamed', userId: null, attachmentCount: 0 }])
    await deleteVolumeDefinition(id, admin)
    expect(await listVolumeDefinitions(admin)).toEqual([])
    expect(fs.existsSync(folder)).toBe(true)
  })
  it('deletes a GitHub copy by id even when its stored config is invalid', async () => {
    vi.stubEnv('SUPERAGENT_DATA_DIR', folder)
    const copy = path.join(folder, 'volumes', 'github-volume', 'copy')
    fs.mkdirSync(copy, { recursive: true })
    await handle.db.insert(volumeDefinitions).values({
      id: 'github-volume', name: 'Broken', type: 'github', config: '{}', userId: null,
      createdAt: new Date(), updatedAt: new Date(),
    }).run()
    await deleteVolumeDefinition('github-volume', local)
    expect(await handle.db.select().from(volumeDefinitions).all()).toEqual([])
    expect(fs.existsSync(copy)).toBe(false)
    await expect(deleteVolumeDefinition('github-volume', local)).rejects.toMatchObject({ status: 404 })
  })
  it('refuses to delete a GitHub drive with edits not on GitHub unless the delete discards them', async () => {
    const config = JSON.stringify({ accountId: 'account', repoId: 1, owner: 'team', repo: 'project', branch: 'main', path: '' })
    await handle.db.insert(volumeDefinitions).values({ id: 'github-volume', name: 'Project', type: 'github', config, userId: null, createdAt: new Date(), updatedAt: new Date() }).run()
    fs.mkdirSync(path.join(folder, 'volumes', 'github-volume'), { recursive: true })
    fs.writeFileSync(path.join(folder, 'volumes', 'github-volume', 'edits.json'), JSON.stringify({
      version: 1, unpushed: { 'notes.txt': { agents: ['agent'], n: 1, sha: null } }, held: {}, stopped: null, ignores: [], links: [],
    }))
    expect(await deleteVolumeDefinition('github-volume', local)).toBe(1)
    expect(await handle.db.select().from(volumeDefinitions).all()).toHaveLength(1)
    expect(await deleteVolumeDefinition('github-volume', local, true)).toBe(0)
    expect(await handle.db.select().from(volumeDefinitions).all()).toEqual([])
  })
  it('uses public definitions in single-user mode and rejects ownerless private definitions', async () => {
    const id = await createVolumeDefinition(input(), local)
    expect(await listVolumeDefinitions(local)).toMatchObject([{ id, userId: null, canManage: true }])
    await expect(createVolumeDefinition({ ...input(), visibility: 'private' }, local)).rejects.toMatchObject({ status: 400 })
  })
  it('does not grant an attachment if visibility changes concurrently', async () => {
    const id = await createVolumeDefinition({ ...input(), visibility: 'public' }, admin)
    const [attachment, change] = await Promise.allSettled([
      attachMount('agent', id, bob), updateVolumeDefinition(id, { name: 'Notes', visibility: 'private' }, admin),
    ])
    expect([attachment.status, change.status].sort()).toEqual(['fulfilled', 'rejected'])
    if (attachment.status === 'fulfilled') {
      expect(await listVolumeDefinitions(bob)).toMatchObject([{ id, userId: null, attachmentCount: 1 }])
    } else {
      expect(await listVolumeDefinitions(bob)).toEqual([])
    }
  })
})
