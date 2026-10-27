import { and, eq, gt, isNull, like, or } from 'drizzle-orm'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { hostState } from '@shared/lib/db/schema'

export interface HostStateEntry {
  value: string
  version: number
}

/**
 * Host state shared by every process that serves one host. Writes are
 * compare-and-set on `version`, so two isolates cannot lose each other's update.
 */
export interface HostStateStore {
  get(key: string): Promise<HostStateEntry | null>
  /** Every live entry whose key is one of `keys` or starts with one of `prefixes`. */
  getMany(keys: string[], prefixes: string[]): Promise<Map<string, HostStateEntry>>
  /** Writes when the stored version equals `expectedVersion` (0 = key absent). Returns the new version, or null on conflict. */
  compareAndSet(key: string, value: string, expectedVersion: number, expiresAt?: number | null): Promise<number | null>
  /** Inserts unless the key exists, then returns what is stored. */
  insertIfAbsent(key: string, value: string, expiresAt?: number | null): Promise<HostStateEntry>
  /** Deletes the key and returns what it held. */
  take(key: string): Promise<string | null>
  delete(key: string): Promise<void>
}

function live(now: number) {
  return or(isNull(hostState.expiresAt), gt(hostState.expiresAt, now))
}

export function databaseHostStateStore(db: AppDatabase): HostStateStore {
  return {
    async get(key) {
      const rows = await db
        .select({ value: hostState.value, version: hostState.version })
        .from(hostState)
        .where(and(eq(hostState.key, key), live(Date.now())))
      return rows[0] ?? null
    },

    async getMany(keys, prefixes) {
      const matches = [
        ...keys.map((k) => eq(hostState.key, k)),
        ...prefixes.map((p) => like(hostState.key, `${p}%`)),
      ]
      const out = new Map<string, HostStateEntry>()
      if (matches.length === 0) return out
      const rows = await db
        .select({ key: hostState.key, value: hostState.value, version: hostState.version })
        .from(hostState)
        .where(and(or(...matches), live(Date.now())))
      for (const row of rows) out.set(row.key, { value: row.value, version: row.version })
      return out
    },

    async compareAndSet(key, value, expectedVersion, expiresAt = null) {
      const next = expectedVersion + 1
      if (expectedVersion === 0) {
        const rows = await db
          .insert(hostState)
          .values({ key, value, version: next, expiresAt })
          .onConflictDoNothing()
          .returning({ version: hostState.version })
        return rows[0]?.version ?? null
      }
      const rows = await db
        .update(hostState)
        .set({ value, version: next, expiresAt })
        .where(and(eq(hostState.key, key), eq(hostState.version, expectedVersion)))
        .returning({ version: hostState.version })
      return rows[0]?.version ?? null
    },

    async insertIfAbsent(key, value, expiresAt = null) {
      await db.insert(hostState).values({ key, value, version: 1, expiresAt }).onConflictDoNothing()
      const rows = await db
        .select({ value: hostState.value, version: hostState.version })
        .from(hostState)
        .where(eq(hostState.key, key))
      return rows[0]
    },

    async take(key) {
      const rows = await db
        .delete(hostState)
        .where(and(eq(hostState.key, key), live(Date.now())))
        .returning({ value: hostState.value })
      return rows[0]?.value ?? null
    },

    async delete(key) {
      await db.delete(hostState).where(eq(hostState.key, key))
    },
  }
}

