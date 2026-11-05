/**
 * An app record store in memory, with the database store's semantics
 * (insert-if-absent, revision compare-and-set). For unit tests that do not
 * need a database; the database store has its own tests on every driver.
 */
import type { AppRecordStore, StoredRecord } from '../record-store'
import { installAppRecordStore, uninstallAppRecordStore } from '../records'

export class MemoryAppRecordStore implements AppRecordStore {
  readonly rows = new Map<string, StoredRecord>()
  /** Counts of each operation, for tests that check how often a path reads. */
  readonly calls = { read: 0, list: 0, insertIfAbsent: 0, compareAndSet: 0, delete: 0 }

  async read(key: string): Promise<StoredRecord | null> {
    this.calls.read++
    return this.rows.get(key) ?? null
  }

  async list(prefix: string): Promise<Array<StoredRecord & { key: string }>> {
    this.calls.list++
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, row]) => ({ key, ...row }))
  }

  async insertIfAbsent(key: string, value: string): Promise<boolean> {
    this.calls.insertIfAbsent++
    if (this.rows.has(key)) return false
    this.rows.set(key, { value, revision: 1 })
    return true
  }

  async compareAndSet(key: string, revision: number, value: string): Promise<boolean> {
    this.calls.compareAndSet++
    const row = this.rows.get(key)
    if (!row || row.revision !== revision) return false
    this.rows.set(key, { value, revision: revision + 1 })
    return true
  }

  async delete(key: string): Promise<void> {
    this.calls.delete++
    this.rows.delete(key)
  }
}

/**
 * Install `store` (a fresh in-memory one by default) as the process's record
 * store, replacing any earlier one, and return it so the test can seed or
 * inspect rows. Every test already starts with a fresh in-memory store (the
 * vitest setup file, `vitest-setup.ts`), so call this only to get hold of the
 * store or to install a different one (a counting store, a database store):
 *
 *   beforeEach(() => { records = installTestAppRecordStore() })
 */
export function installTestAppRecordStore(store: AppRecordStore = new MemoryAppRecordStore()): typeof store {
  uninstallAppRecordStore()
  installAppRecordStore(store)
  return store
}

/** The store a file kept across its tests, if it asked to. */
let keptForFile: AppRecordStore | null = null

/**
 * Keep one store for every test of this file instead of a fresh one per test:
 * for a file that seeds records once in `beforeAll` (an auth secret its
 * sessions are signed with, settings an app instance was built from). Call it
 * in `beforeAll`, before seeding. Each test file runs in its own module
 * registry, so this ends with the file.
 */
export function keepAppRecordStoreAcrossTests(store: AppRecordStore = new MemoryAppRecordStore()): typeof store {
  keptForFile = store
  return installTestAppRecordStore(store)
}

/**
 * What the vitest setup file runs before every test: the store this file
 * kept, or a fresh in-memory store.
 */
export function resetTestAppRecordStore(): void {
  installTestAppRecordStore(keptForFile ?? new MemoryAppRecordStore())
}
