import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { agents, agentVolumes, volumeDefinitions } from '@shared/lib/db/schema'
import { addMount, attachMount, getMounts } from './mount-service'
import { createVolumeDefinition, deleteVolumeDefinition, updateVolumeDefinition } from './volume-service'

let handle: TestDatabase
let folder: string
const viewer = { userId: null, admin: true }
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
beforeEach(async () => {
  folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mount-atomic-')))
  handle = await createTestDatabase()
  await handle.db.insert(agents).values({ slug: 'agent', name: 'Agent', createdAt: new Date() }).run()
})
afterEach(async () => {
  await handle.close()
  fs.rmSync(folder, { recursive: true, force: true })
})

describe('atomic volume writes', () => {
  it('rolls back the definition when creating its attachment fails', async () => {
    await expect(addMount('missing-agent', 'local', { path: folder }, viewer)).rejects.toThrow()
    expect(await handle.db.select().from(volumeDefinitions).all()).toEqual([])
    expect(await handle.db.select().from(agentVolumes).all()).toEqual([])
  })
  it('keeps concurrent additions and allocates distinct mount names', async () => {
    await Promise.all(Array.from({ length: 5 }, () => addMount('agent', 'local', { path: folder }, viewer, { name: 'notes' })))
    expect((await getMounts('agent')).map(m => m.name).sort()).toEqual(['notes', 'notes-2', 'notes-3', 'notes-4', 'notes-5'])
    expect(await handle.db.select().from(volumeDefinitions).all()).toHaveLength(5)
  })
  it('makes concurrent attachment of one saved source idempotent', async () => {
    const id = await createVolumeDefinition({ type: 'local', config: { path: folder } }, viewer)
    const mounts = await Promise.all(Array.from({ length: 5 }, () => attachMount('agent', id, viewer)))
    expect(new Set(mounts.map(m => m.id)).size).toBe(1)
    expect(await getMounts('agent')).toHaveLength(1)
  })
  it('never deletes a source that won a race to attach', async () => {
    const id = await createVolumeDefinition({ type: 'local', config: { path: folder } }, viewer)
    const [attachment, deletion] = await Promise.allSettled([attachMount('agent', id, viewer), deleteVolumeDefinition(id, viewer)])
    if (attachment.status === 'fulfilled') {
      expect(deletion.status).toBe('rejected')
      expect(await getMounts('agent')).toHaveLength(1)
    } else {
      expect(deletion.status).toBe('fulfilled')
      expect(await getMounts('agent')).toEqual([])
      expect(await handle.db.select().from(volumeDefinitions).all()).toEqual([])
    }
  })
  it('allows renaming an attached public source', async () => {
    const mount = await addMount('agent', 'local', { path: folder }, viewer)
    await updateVolumeDefinition(mount.volumeId, { name: 'new-name', visibility: 'public' }, viewer)
    expect(await getMounts('agent')).toEqual([mount])
  })
})
