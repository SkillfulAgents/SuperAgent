import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

vi.mock('../db', () => ({
  get db() {
    return testDb
  },
}))

const mockEnsureDirectory = vi.fn()
const mockRemoveDirectory = vi.fn()

vi.mock('../utils/file-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/file-storage')>()
  return {
    ...actual,
    ensureDirectory: (...args: unknown[]) => mockEnsureDirectory(...args),
    removeDirectory: (...args: unknown[]) => mockRemoveDirectory(...args),
  }
})

const mockIsAuthMode = vi.fn(() => false)
vi.mock('../auth/mode', () => ({
  isAuthMode: () => mockIsAuthMode(),
}))

import {
  MAX_SHARED_VOLUMES_PER_AGENT,
  SharedVolumeError,
  createSharedVolume,
  listSharedVolumes,
  attachSharedVolume,
  detachSharedVolume,
  deleteSharedVolume,
  getAgentSharedVolumes,
} from './shared-volume-service'

describe('shared-volume-service', () => {
  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shared-volume-test-'))
    process.env.SUPERAGENT_DATA_DIR = testDir
    testSqlite = new Database(':memory:')
    testSqlite.pragma('foreign_keys = ON')
    testDb = drizzle(testSqlite, { schema })
    migrate(testDb, { migrationsFolder: path.join(process.cwd(), 'src/shared/lib/db/migrations') })
    mockEnsureDirectory.mockReset()
    mockEnsureDirectory.mockResolvedValue(undefined)
    mockRemoveDirectory.mockReset()
    mockRemoveDirectory.mockResolvedValue(undefined)
    mockIsAuthMode.mockReturnValue(false)
  })

  afterEach(async () => {
    testSqlite?.close()
    delete process.env.SUPERAGENT_DATA_DIR
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('create derives mountName and rejects empty, overlong, and duplicate names', async () => {
    const created = await createSharedVolume('Team Brain')
    expect(created.mountName).toBe('team-brain')
    expect(created.name).toBe('Team Brain')
    expect(mockEnsureDirectory).toHaveBeenCalledWith(path.join(testDir, 'volumes', created.id))

    await expect(createSharedVolume('!!!')).rejects.toMatchObject({ status: 400 })
    await expect(createSharedVolume('TEAM BRAIN')).rejects.toMatchObject({ status: 400 })
  })

  it('create mkdir-failure deletes the row', async () => {
    mockEnsureDirectory.mockRejectedValueOnce(new Error('disk full'))
    await expect(createSharedVolume('Scraped Data')).rejects.toThrow('disk full')
    expect(listSharedVolumes()).toEqual([])
  })

  it('attach enforces uniqueness and the per-agent cap', async () => {
    const first = await createSharedVolume('One')
    attachSharedVolume('agent-a', first.id)
    expect(() => attachSharedVolume('agent-a', first.id)).toThrowError(SharedVolumeError)
    try {
      attachSharedVolume('agent-a', first.id)
    } catch (error) {
      expect(error).toBeInstanceOf(SharedVolumeError)
      expect((error as SharedVolumeError).status).toBe(409)
    }

    for (let i = 1; i < MAX_SHARED_VOLUMES_PER_AGENT; i++) {
      const vol = await createSharedVolume(`Vol ${i}`)
      attachSharedVolume('agent-a', vol.id)
    }
    const overflow = await createSharedVolume('Overflow')
    try {
      attachSharedVolume('agent-a', overflow.id)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(SharedVolumeError)
      expect((error as SharedVolumeError).status).toBe(409)
    }
  })

  it('detach removes only the junction row', async () => {
    const vol = await createSharedVolume('Shared')
    attachSharedVolume('agent-a', vol.id)
    attachSharedVolume('agent-b', vol.id)
    detachSharedVolume('agent-a', vol.id)
    expect(getAgentSharedVolumes('agent-a')).toEqual([])
    expect(getAgentSharedVolumes('agent-b')).toEqual([{ id: vol.id, mountName: 'shared' }])
    expect(listSharedVolumes()).toHaveLength(1)
  })

  it('delete with zero attachments removes the row and directory', async () => {
    const vol = await createSharedVolume('Orphan')
    await deleteSharedVolume(vol.id, { userId: null, isAdmin: false })
    expect(listSharedVolumes()).toEqual([])
    expect(mockRemoveDirectory).toHaveBeenCalledWith(path.join(testDir, 'volumes', vol.id))
  })

  it('delete with sole usable attachment removes the volume and its attachment', async () => {
    const vol = await createSharedVolume('Last One')
    attachSharedVolume('agent-a', vol.id)
    await deleteSharedVolume(vol.id, { userId: null, isAdmin: false })
    expect(listSharedVolumes()).toEqual([])
    expect(getAgentSharedVolumes('agent-a')).toEqual([])
    expect(mockRemoveDirectory).toHaveBeenCalled()
  })

  it('delete of a sole attachment is refused when the caller cannot use that agent', async () => {
    mockIsAuthMode.mockReturnValue(true)
    testDb.insert(schema.user).values({
      id: 'user-1',
      name: 'User user-1',
      email: 'user-1@test.com',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run()
    const vol = await createSharedVolume('Locked')
    attachSharedVolume('secret-agent', vol.id)
    await expect(
      deleteSharedVolume(vol.id, { userId: 'user-1', isAdmin: false }),
    ).rejects.toMatchObject({ status: 409 })
    expect(listSharedVolumes()).toHaveLength(1)
    expect(mockRemoveDirectory).not.toHaveBeenCalled()
  })

  it('delete with another agent attached returns 409', async () => {
    const vol = await createSharedVolume('Busy')
    attachSharedVolume('agent-a', vol.id)
    attachSharedVolume('agent-b', vol.id)
    await expect(deleteSharedVolume(vol.id, { userId: null, isAdmin: false })).rejects.toMatchObject({
      status: 409,
    })
    expect(listSharedVolumes()).toHaveLength(1)
    expect(mockRemoveDirectory).not.toHaveBeenCalled()
  })

  it('delete rm-failure logs and still resolves after the row is gone', async () => {
    const vol = await createSharedVolume('Residue')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockRemoveDirectory.mockRejectedValueOnce(new Error('busy'))
    await deleteSharedVolume(vol.id, { userId: null, isAdmin: false })
    expect(listSharedVolumes()).toEqual([])
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('getAgentSharedVolumes returns id and mountName pairs', async () => {
    const vol = await createSharedVolume('Team Brain')
    attachSharedVolume('agent-a', vol.id)
    expect(getAgentSharedVolumes('agent-a')).toEqual([{ id: vol.id, mountName: 'team-brain' }])
    expect(getAgentSharedVolumes('agent-b')).toEqual([])
  })
})
