import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import {
  getOrCreatePlatformClientInstanceId,
  getPlatformDeviceName,
} from './platform-device-service'

// The client instance id is a host record in the app database: a fresh test database per test.
let handle: TestDatabase
let testDb: TestDatabase['db']
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

describe('platform-device-service', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await handle.close()
  })

  it('persists a stable client instance id', async () => {
    const first = await getOrCreatePlatformClientInstanceId()
    const second = await getOrCreatePlatformClientInstanceId()

    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  it('agrees on one id when first uses race', async () => {
    const ids = await Promise.all([getOrCreatePlatformClientInstanceId(), getOrCreatePlatformClientInstanceId()])

    expect(ids[1]).toBe(ids[0])
    expect(await getOrCreatePlatformClientInstanceId()).toBe(ids[0])
  })

  it('returns a non-empty device name', () => {
    const name = getPlatformDeviceName()
    expect(name).toBeTruthy()
    expect(typeof name).toBe('string')
    expect(name.length).toBeGreaterThan(0)
  })
})
