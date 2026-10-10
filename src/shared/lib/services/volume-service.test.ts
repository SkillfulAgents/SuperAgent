import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, user } from '@shared/lib/db/schema'
import { attachMount, removeMount } from './mount-service'
import { createVolumeDefinition, deleteVolumeDefinition, listVolumeDefinitions, updateVolumeDefinition } from './volume-service'

let handle: TestDatabase
let folder: string
const alice = { userId: 'alice', admin: false }
const bob = { userId: 'bob', admin: false }
const admin = { userId: 'admin', admin: true }
const local = { userId: null, admin: true }
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
beforeEach(async () => {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'volume-access-')))
  handle = await createTestDatabase()
  await handle.db.insert(user).values(['alice', 'bob', 'admin'].map(id => ({ id, name: id, email: `${id}@example.com` }))).run()
  await handle.db.insert(agents).values({ slug: 'agent', name: 'Agent', createdAt: new Date() }).run()
})
afterEach(async () => {
  await handle.close()
  fs.rmSync(folder, { recursive: true, force: true })
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
  it('blocks deletion and changes of scope until attachments are removed, but permits renames', async () => {
    const id = await createVolumeDefinition(input(), admin)
    const mount = await attachMount('agent', id, admin)
    expect(await listVolumeDefinitions(admin)).toMatchObject([{ attachmentCount: 1 }])
    await expect(deleteVolumeDefinition(id, admin)).rejects.toMatchObject({ status: 409 })
    await expect(updateVolumeDefinition(id, { name: 'Notes', visibility: 'public' }, admin)).rejects.toMatchObject({ status: 409 })
    await updateVolumeDefinition(id, { name: 'Renamed', visibility: 'private' }, admin)
    await removeMount('agent', mount.id)
    await updateVolumeDefinition(id, { name: 'Renamed', visibility: 'public' }, admin)
    expect(await listVolumeDefinitions(alice)).toMatchObject([{ id, userId: null, attachmentCount: 0 }])
    await deleteVolumeDefinition(id, admin)
    expect(await listVolumeDefinitions(admin)).toEqual([])
    expect(fs.existsSync(folder)).toBe(true)
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
