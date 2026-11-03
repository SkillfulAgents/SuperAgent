/**
 * A key-value cache for data a process can fetch again. It may lose any entry at any time, and a
 * host with several processes may serve a value another process replaced a short time ago, so it
 * never holds state that must be read back exactly (locks, counters, sessions). Values are
 * JSON-serializable; a read returns a copy. Each user starts its keys with its own prefix
 * (`oidc-jwks:<issuer>`).
 */
export interface KVStore {
  get<T = unknown>(key: string): Promise<T | null>
  get<T = unknown>(keys: string[]): Promise<Map<string, T | null>>
  /** `ttlMs` is how long the entry may be served; without it the entry has no expiry. */
  put(key: string, value: unknown, ttlMs?: number): Promise<void>
  delete(key: string | string[]): Promise<void>
}

interface Entry {
  json: string
  expiresAt: number | null
}

/**
 * The store of a host with one long-running process (desktop, Docker, ECS). It serializes values,
 * as a remote store does, so a caller that changes a value it read changes only its copy.
 */
export class InMemoryKVStore implements KVStore {
  private readonly entries = new Map<string, Entry>()

  get<T = unknown>(key: string): Promise<T | null>
  get<T = unknown>(keys: string[]): Promise<Map<string, T | null>>
  async get<T>(keyOrKeys: string | string[]): Promise<T | null | Map<string, T | null>> {
    if (typeof keyOrKeys === 'string') return this.read<T>(keyOrKeys)
    return new Map(keyOrKeys.map((key) => [key, this.read<T>(key)]))
  }

  async put(key: string, value: unknown, ttlMs?: number): Promise<void> {
    const json = JSON.stringify(value)
    if (json === undefined) throw new TypeError(`KVStore value for ${key} is not JSON-serializable`)
    this.entries.set(key, { json, expiresAt: ttlMs === undefined ? null : Date.now() + ttlMs })
  }

  async delete(keyOrKeys: string | string[]): Promise<void> {
    for (const key of typeof keyOrKeys === 'string' ? [keyOrKeys] : keyOrKeys) this.entries.delete(key)
  }

  private read<T>(key: string): T | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return null
    }
    return JSON.parse(entry.json) as T
  }
}

let kvCacheStore: KVStore = new InMemoryKVStore()

export function getKVCacheStore(): KVStore {
  return kvCacheStore
}

/** Installed once by a host whose processes start often, before the API serves anything. */
export function setKVCacheStore(store: KVStore): void {
  kvCacheStore = store
}
