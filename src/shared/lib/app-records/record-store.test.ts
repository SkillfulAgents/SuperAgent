import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { dbAppRecordStore, type AppRecordStore } from './record-store'
import { MemoryAppRecordStore } from './testing/memory-record-store'

// The database store on the test driver (DB_DRIVER=libsql runs it on libsql),
// and the in-memory store unit tests use, held to the same contract.
const stores: Array<[string, () => Promise<{ store: AppRecordStore; close(): Promise<void> }>]> = [
  ['database', async () => {
    const handle: TestDatabase = await createTestDatabase()
    return { store: dbAppRecordStore(handle.db), close: () => handle.close() }
  }],
  ['memory', async () => ({ store: new MemoryAppRecordStore(), close: async () => {} })],
]

describe.each(stores)('%s app record store', (_name, open) => {
  let store: AppRecordStore
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ store, close } = await open())
  })
  afterEach(async () => {
    await close()
  })

  it('reads null for an absent key', async () => {
    expect(await store.read('absent')).toBeNull()
  })

  it('inserts once: a second insert of the same key does nothing and reports it', async () => {
    expect(await store.insertIfAbsent('k', '"first"')).toBe(true)
    expect(await store.insertIfAbsent('k', '"second"')).toBe(false)
    expect(await store.read('k')).toEqual({ value: '"first"', revision: 1 })
  })

  it('writes only at the revision the writer read, and bumps it', async () => {
    await store.insertIfAbsent('k', '1')
    expect(await store.compareAndSet('k', 1, '2')).toBe(true)
    expect(await store.read('k')).toEqual({ value: '2', revision: 2 })
    // A writer still holding revision 1 lost: nothing changes.
    expect(await store.compareAndSet('k', 1, 'stale')).toBe(false)
    expect(await store.read('k')).toEqual({ value: '2', revision: 2 })
  })

  it('does not create a record through compare-and-set', async () => {
    expect(await store.compareAndSet('absent', 0, '1')).toBe(false)
    expect(await store.read('absent')).toBeNull()
  })

  it('lists exactly the keys with a prefix: case and wildcard characters are literal', async () => {
    for (const key of ['tok:a', 'tok:b_c', 'tok_x', 'TOK:upper', 'tok', 'other']) {
      await store.insertIfAbsent(key, '1')
    }
    const keys = (await store.list('tok:')).map((row) => row.key).sort()
    expect(keys).toEqual(['tok:a', 'tok:b_c'])
  })

  it('deletes a key', async () => {
    await store.insertIfAbsent('k', '1')
    await store.delete('k')
    expect(await store.read('k')).toBeNull()
    // A deleted key can be created again.
    expect(await store.insertIfAbsent('k', '2')).toBe(true)
  })
})
