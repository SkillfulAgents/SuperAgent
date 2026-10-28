import { and, eq, gt, isNull, like, lte, or, sql } from 'drizzle-orm'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { hostState } from '@shared/lib/db/schema'

export interface HostStateEntry {
  value: string
  version: number
  expiresAt?: number | null
}

/** A counter and when it lapses (ms); null = never. */
export interface HostCounter {
  count: number
  until: number | null
}

/**
 * Host state shared by every process that serves one host. Writes are
 * compare-and-set on `version`, so two isolates cannot lose each other's update.
 */
export interface HostStateStore {
  /** True when other processes read the same state, so a secret written here must be sealed. */
  readonly shared: boolean
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
  /** Deletes every key that starts with `prefix`. */
  deletePrefix(prefix: string): Promise<void>
  /** Counts a hit in a fixed window that starts with the first hit after the last window lapsed. Atomic. */
  hitWindow(key: string, windowMs: number): Promise<HostCounter>
  /**
   * Counts a failure. Once the count reaches `threshold` the counter holds
   * until `lockMs` from now; before that it never lapses. A lapsed counter
   * starts again at 1. Atomic.
   */
  recordFailure(key: string, threshold: number, lockMs: number): Promise<HostCounter>
}

function live(now: number) {
  return or(isNull(hostState.expiresAt), gt(hostState.expiresAt, now))
}

function counterOf(row: { value: unknown; expires_at: unknown } | undefined): HostCounter {
  if (!row) throw new Error('Counter write returned no row')
  return { count: Number(row.value), until: row.expires_at === null ? null : Number(row.expires_at) }
}

export function databaseHostStateStore(db: AppDatabase): HostStateStore {
  return {
    shared: true,

    async get(key) {
      const rows = await db
        .select({ value: hostState.value, version: hostState.version, expiresAt: hostState.expiresAt })
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
        .select({ key: hostState.key, value: hostState.value, version: hostState.version, expiresAt: hostState.expiresAt })
        .from(hostState)
        .where(and(or(...matches), live(Date.now())))
      for (const row of rows) out.set(row.key, { value: row.value, version: row.version, expiresAt: row.expiresAt })
      return out
    },

    async compareAndSet(key, value, expectedVersion, expiresAt = null) {
      const next = expectedVersion + 1
      if (expectedVersion === 0) {
        // A lapsed row counts as absent: replace it in the same statement.
        const rows = await db
          .insert(hostState)
          .values({ key, value, version: next, expiresAt })
          .onConflictDoUpdate({
            target: hostState.key,
            set: { value, version: next, expiresAt },
            setWhere: lte(hostState.expiresAt, Date.now()),
          })
          .returning({ version: hostState.version })
        return rows[0]?.version ?? null
      }
      const rows = await db
        .update(hostState)
        .set({ value, version: next, expiresAt })
        .where(and(eq(hostState.key, key), eq(hostState.version, expectedVersion), live(Date.now())))
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

    async deletePrefix(prefix) {
      await db.delete(hostState).where(like(hostState.key, `${prefix}%`))
    },

    async hitWindow(key, windowMs) {
      const now = Date.now()
      // SET expressions all read the old row, so `expires_at` below is the previous window.
      const rows = await db.all<{ value: unknown; expires_at: unknown }>(sql`
        INSERT INTO host_state (key, value, version, expires_at) VALUES (${key}, '1', 1, ${now + windowMs})
        ON CONFLICT(key) DO UPDATE SET
          value = CASE WHEN host_state.expires_at <= ${now} THEN '1' ELSE CAST(CAST(host_state.value AS INTEGER) + 1 AS TEXT) END,
          version = host_state.version + 1,
          expires_at = CASE WHEN host_state.expires_at <= ${now} THEN ${now + windowMs} ELSE host_state.expires_at END
        RETURNING value, expires_at`)
      return counterOf(rows[0])
    },

    async recordFailure(key, threshold, lockMs) {
      const now = Date.now()
      const first = threshold <= 1 ? now + lockMs : null
      const rows = await db.all<{ value: unknown; expires_at: unknown }>(sql`
        INSERT INTO host_state (key, value, version, expires_at) VALUES (${key}, '1', 1, ${first})
        ON CONFLICT(key) DO UPDATE SET
          value = CASE WHEN host_state.expires_at <= ${now} THEN '1' ELSE CAST(CAST(host_state.value AS INTEGER) + 1 AS TEXT) END,
          version = host_state.version + 1,
          expires_at = CASE
            WHEN host_state.expires_at <= ${now} THEN ${first}
            WHEN CAST(host_state.value AS INTEGER) + 1 >= ${threshold} THEN ${now + lockMs}
            ELSE host_state.expires_at END
        RETURNING value, expires_at`)
      return counterOf(rows[0])
    },
  }
}

/** Removes lapsed rows: lapsed rows are already invisible, this only reclaims space. */
export async function deleteExpiredHostState(db: AppDatabase): Promise<void> {
  await db.delete(hostState).where(lte(hostState.expiresAt, Date.now()))
}

interface MemoryRow {
  value: string
  version: number
  expiresAt: number | null
}

/**
 * The same contract in this process's memory, for a host that runs as one
 * process (desktop, single-tenant web): what the module-level maps did.
 */
export function memoryHostStateStore(): HostStateStore & { clear(): void } {
  const rows = new Map<string, MemoryRow>()
  const lapsed = (row: MemoryRow | undefined, now = Date.now()) => !row || (row.expiresAt !== null && row.expiresAt <= now)
  const liveRow = (key: string) => {
    const row = rows.get(key)
    if (lapsed(row)) {
      rows.delete(key)
      return undefined
    }
    return row
  }
  const sweep = () => {
    if (rows.size < 1000) return
    const now = Date.now()
    for (const [key, row] of rows) if (lapsed(row, now)) rows.delete(key)
  }
  return {
    shared: false,
    clear: () => rows.clear(),

    async get(key) {
      const row = liveRow(key)
      return row ? { ...row } : null
    },

    async getMany(keys, prefixes) {
      const out = new Map<string, HostStateEntry>()
      for (const key of [...rows.keys()]) {
        if (!keys.includes(key) && !prefixes.some((p) => key.startsWith(p))) continue
        const row = liveRow(key)
        if (row) out.set(key, { ...row })
      }
      return out
    },

    async compareAndSet(key, value, expectedVersion, expiresAt = null) {
      const row = liveRow(key)
      if ((row?.version ?? 0) !== expectedVersion) return null
      sweep()
      rows.set(key, { value, version: expectedVersion + 1, expiresAt })
      return expectedVersion + 1
    },

    async insertIfAbsent(key, value, expiresAt = null) {
      const row = liveRow(key) ?? { value, version: 1, expiresAt }
      rows.set(key, row)
      return { ...row }
    },

    async take(key) {
      const row = liveRow(key)
      rows.delete(key)
      return row?.value ?? null
    },

    async delete(key) {
      rows.delete(key)
    },

    async deletePrefix(prefix) {
      for (const key of [...rows.keys()]) if (key.startsWith(prefix)) rows.delete(key)
    },

    async hitWindow(key, windowMs) {
      const row = liveRow(key)
      const now = Date.now()
      const next = row
        ? { value: String(Number(row.value) + 1), version: row.version + 1, expiresAt: row.expiresAt }
        : { value: '1', version: 1, expiresAt: now + windowMs }
      sweep()
      rows.set(key, next)
      return { count: Number(next.value), until: next.expiresAt }
    },

    async recordFailure(key, threshold, lockMs) {
      const row = liveRow(key)
      const count = row ? Number(row.value) + 1 : 1
      const expiresAt = count >= threshold ? Date.now() + lockMs : (row?.expiresAt ?? null)
      sweep()
      rows.set(key, { value: String(count), version: (row?.version ?? 0) + 1, expiresAt })
      return { count, until: expiresAt }
    },
  }
}
