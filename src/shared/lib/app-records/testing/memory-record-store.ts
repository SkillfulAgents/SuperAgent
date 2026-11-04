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
 * Install a fresh in-memory store as the process's record store, replacing
 * any earlier one; returns it so the test can seed or inspect rows.
 *
 *   beforeEach(() => { records = installTestAppRecordStore() })
 */
export function installTestAppRecordStore(store: AppRecordStore = new MemoryAppRecordStore()): typeof store {
  uninstallAppRecordStore()
  installAppRecordStore(store)
  return store
}
