import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import * as schema from '../db/schema'

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('@shared/lib/db', () => ({
  get db() { return testDb },
}))
const { listDirectories, getAuth, initEnvManagedPlatformStatus } = vi.hoisted(() => ({
  listDirectories: vi.fn(async () => [] as string[]),
  getAuth: vi.fn(),
  initEnvManagedPlatformStatus: vi.fn(async () => {}),
}))
vi.mock('@shared/lib/utils/file-storage', () => ({ listDirectories }))
vi.mock('./index', () => ({ getAuth }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({ initEnvManagedPlatformStatus }))
vi.mock('./provider-config', () => ({ getPublicAuthProviders: () => [] }))

import { validateAuthModeStartup } from './startup-validation'

describe('validateAuthModeStartup', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
    vi.clearAllMocks()
  })
  afterEach(async () => {
    await handle.close()
  })

  it('starts normally when there are users, without looking at the agents folder', async () => {
    await testDb.insert(schema.user).values({
      id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com', emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    }).run()

    await validateAuthModeStartup()

    expect(listDirectories).not.toHaveBeenCalled()
    expect(getAuth).toHaveBeenCalled()
  })

  it('refuses to start when there is no user table but agents already exist', async () => {
    await testDb.run(sql`PRAGMA foreign_keys = OFF`)
    await testDb.run(sql`DROP TABLE user`)
    listDirectories.mockResolvedValueOnce(['sales-agent'])

    await expect(validateAuthModeStartup()).rejects.toThrow('Cannot enable AUTH_MODE with existing data')
  })

  it('starts fresh when the user table is empty and there are no agents', async () => {
    await validateAuthModeStartup()

    expect(listDirectories).toHaveBeenCalled()
    expect(getAuth).toHaveBeenCalled()
  })
})
