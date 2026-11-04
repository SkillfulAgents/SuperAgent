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
 * Short-lived keyed state (sign-in flows, rate limits, caches) for every
 * process that serves one host. Writes are compare-and-set on `version`, so
 * two processes cannot lose each other's update. Desktop keeps it in this
 * process's memory; a deployment that serves one host from many processes
 * installs a shared store once at boot with `setHostStateStore`.
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

interface MemoryRow {
  value: string
  version: number
  expiresAt: number | null
}

/**
 * The contract in this process's memory, for a host that runs as one process
 * (desktop, single-tenant web): what the module-level maps did.
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

const processStore = memoryHostStateStore()
let store: HostStateStore = processStore

export function hostStateStore(): HostStateStore {
  return store
}

/** Installs the shared store once at boot. Desktop keeps this process's memory. */
export function setHostStateStore(next: HostStateStore): void {
  store = next
}

/** Test seam: forget this process's state. */
export function resetProcessHostState(): void {
  processStore.clear()
}
