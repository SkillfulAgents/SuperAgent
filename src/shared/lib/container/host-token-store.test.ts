import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { MemoryAppRecordStore, installTestAppRecordStore } from '@shared/lib/app-records/testing/memory-record-store'
import { uninstallAppRecordStore } from '@shared/lib/app-records/records'
import { hostContainerTokenKey } from '@shared/lib/app-records/record-schemas'
import { getOrCreateHostToken } from './host-token-store'

// The token store is one app record per agent. Concurrency across processes
// and corrupt rows are covered with the record store itself
// (app-records/host-records.test.ts); the legacy file's import, by its data
// migration (db/data-migrations/0009-import-host-records.test.ts).
describe('host-token-store', () => {
  let store: MemoryAppRecordStore

  beforeEach(() => {
    store = new MemoryAppRecordStore()
    installTestAppRecordStore(store)
  })

  afterEach(() => {
    uninstallAppRecordStore()
  })

  it('creates a token per agent and returns the same one on later calls', async () => {
    const first = await getOrCreateHostToken('agent-a')
    expect(first).toMatch(/^hostc_[0-9a-f]{64}$/)
    expect(await getOrCreateHostToken('agent-a')).toBe(first)
    expect(await getOrCreateHostToken('agent-b')).not.toBe(first)
  })

  it('keeps each agent\'s token in its own record, which a later process reads back', async () => {
    const token = await getOrCreateHostToken('agent-a')
    expect(store.rows.has(hostContainerTokenKey('agent-a'))).toBe(true)
    expect(store.rows.has(hostContainerTokenKey('agent-b'))).toBe(false)

    // A host restart: a fresh process reads the same database.
    const restarted = new MemoryAppRecordStore()
    for (const [key, row] of store.rows) restarted.rows.set(key, row)
    expect(await getOrCreateHostToken('agent-a', restarted)).toBe(token)
  })

  it('agrees on one token when first uses race', async () => {
    const tokens = await Promise.all(Array.from({ length: 5 }, () => getOrCreateHostToken('agent-a')))
    expect(new Set(tokens).size).toBe(1)
  })

  it('reads the record on every call rather than keeping the token', async () => {
    await getOrCreateHostToken('agent-a')
    const reads = store.calls.read
    await getOrCreateHostToken('agent-a')
    expect(store.calls.read).toBe(reads + 1)
  })
})
