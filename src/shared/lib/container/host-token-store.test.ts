import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { readStoredRecord } from '@shared/lib/app-records/records'
import { hostContainerTokenKey } from '@shared/lib/app-records/record-schemas'
import { getOrCreateHostToken } from './host-token-store'

let handle: TestDatabase
let testDb: TestDatabase['db']
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

// The token store is one app record per agent. Concurrency across processes
// and corrupt rows are covered with the records themselves
// (app-records/host-records.test.ts); the legacy file's import, by its data
// migration (db/data-migrations/0009-import-host-records.test.ts).
describe('host-token-store', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await handle.close()
  })

  it('creates a token per agent and returns the same one on later calls', async () => {
    const first = await getOrCreateHostToken('agent-a')
    expect(first).toMatch(/^hostc_[0-9a-f]{64}$/)
    expect(await getOrCreateHostToken('agent-a')).toBe(first)
    expect(await getOrCreateHostToken('agent-b')).not.toBe(first)
  })

  it('keeps each agent\'s token in its own record, which a later process reads back', async () => {
    const token = await getOrCreateHostToken('agent-a')
    // The database, not this process, holds it: a host restart reads this record.
    const stored = await readStoredRecord(hostContainerTokenKey('agent-a'))
    expect(stored && JSON.parse(stored.value)).toBe(token)
    expect(await readStoredRecord(hostContainerTokenKey('agent-b'))).toBeNull()
  })

  it('agrees on one token when first uses race', async () => {
    const tokens = await Promise.all(Array.from({ length: 5 }, () => getOrCreateHostToken('agent-a')))
    expect(new Set(tokens).size).toBe(1)
  })

  it('reads the record on every call rather than keeping the token', async () => {
    await getOrCreateHostToken('agent-a')
    const reads = vi.spyOn(testDb, 'select')
    await getOrCreateHostToken('agent-a')
    expect(reads).toHaveBeenCalledTimes(1)
  })
})
