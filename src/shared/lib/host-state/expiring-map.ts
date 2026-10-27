import type { z } from 'zod'
import { openJson, sealJson } from '@shared/lib/browser-vault/vault-crypto'
import { currentStore } from './scope'
import type { HostStateStore } from './store'

const MAX_ATTEMPTS = 10

/**
 * Short-lived keyed state (a sign-in flow, a held value). Inside a host state
 * scope it lives in the shared store, so any isolate sees it; outside one it
 * lives in this process's memory, as the module-level maps did.
 */
export interface ExpiringMap<T> {
  get(key: string): Promise<T | undefined>
  /** Stores a fresh key; throws when it is taken. `ttlMs` overrides the map's. */
  set(key: string, value: T, ttlMs?: number): Promise<void>
  /** Stores the value, replacing what the key held, with a fresh expiry. */
  put(key: string, value: T): Promise<void>
  /**
   * Replaces the value with `change(current)`, keeping its expiry, and returns
   * the stored value. `change` runs again on a conflict; returning undefined
   * leaves the value as it is. Undefined when the key holds nothing.
   */
  update(key: string, change: (current: T) => T | undefined): Promise<T | undefined>
  delete(key: string): Promise<void>
  /** The live values whose key starts with `prefix`. */
  values(prefix: string): Promise<T[]>
  /** Forgets every key. */
  clear(): Promise<void>
}

export interface ExpiringMapOptions<T> {
  /** Seal values in a shared store: they hold secrets. */
  sealed?: z.ZodType<T>
}

export function expiringMap<T>(namespace: string, ttlMs: number, options: ExpiringMapOptions<T> = {}): ExpiringMap<T> {
  const storeKey = (key: string) => `${namespace}:${key}`
  const binding = (key: string) => ({ purpose: 'host-state' as const, id: storeKey(key), site: '' })
  const encode = (store: HostStateStore, key: string, value: T) =>
    options.sealed && store.shared ? sealJson(value, binding(key), options.sealed) : JSON.stringify(value)
  const decode = (store: HostStateStore, key: string, raw: string): T | undefined => {
    try {
      return options.sealed && store.shared ? openJson(raw, binding(key), options.sealed) : (JSON.parse(raw) as T)
    } catch {
      return undefined
    }
  }

  return {
    async get(key) {
      const store = currentStore()
      const entry = await store.get(storeKey(key))
      return entry ? decode(store, key, entry.value) : undefined
    },

    async set(key, value, ttl = ttlMs) {
      const store = currentStore()
      if ((await store.compareAndSet(storeKey(key), encode(store, key, value), 0, Date.now() + ttl)) === null) {
        throw new Error(`${namespace} key already in use`)
      }
    },

    async put(key, value) {
      const store = currentStore()
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const entry = await store.get(storeKey(key))
        if ((await store.compareAndSet(storeKey(key), encode(store, key, value), entry?.version ?? 0, Date.now() + ttlMs)) !== null) return
      }
      throw new Error(`${namespace} kept changing while writing`)
    },

    async update(key, change) {
      const store = currentStore()
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const entry = await store.get(storeKey(key))
        if (!entry) return undefined
        const current = decode(store, key, entry.value)
        if (current === undefined) return undefined
        const next = change(current)
        if (next === undefined) return current
        if ((await store.compareAndSet(storeKey(key), encode(store, key, next), entry.version, entry.expiresAt ?? null)) !== null) return next
      }
      throw new Error(`${namespace} kept changing while writing`)
    },

    async delete(key) {
      await currentStore().delete(storeKey(key))
    },

    async clear() {
      await currentStore().deletePrefix(`${namespace}:`)
    },

    async values(prefix) {
      const store = currentStore()
      const entries = await store.getMany([], [storeKey(prefix)])
      return [...entries].flatMap(([fullKey, entry]) => {
        const value = decode(store, fullKey.slice(namespace.length + 1), entry.value)
        return value === undefined ? [] : [value]
      })
    },
  }
}
