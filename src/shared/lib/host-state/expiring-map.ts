import type { z } from 'zod'
import { scopedStore } from './scope'

/**
 * Short-lived keyed state (a sign-in flow, a rate-limit window). Inside a host
 * state scope it lives in the shared store, so any isolate sees it; outside
 * one it is an in-process map, as before.
 */
export interface ExpiringMap<T> {
  get(key: string): Promise<T | undefined>
  set(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
}

export function expiringMap<T>(namespace: string, ttlMs: number, schema: z.ZodType<T>): ExpiringMap<T> {
  const memory = new Map<string, { value: T; expiresAt: number }>()
  const storeKey = (key: string) => `${namespace}:${key}`
  return {
    async get(key) {
      const store = scopedStore()
      if (store) {
        const entry = await store.get(storeKey(key))
        if (!entry) return undefined
        try {
          return schema.parse(JSON.parse(entry.value))
        } catch {
          return undefined
        }
      }
      const entry = memory.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= Date.now()) {
        memory.delete(key)
        return undefined
      }
      return entry.value
    },
    async set(key, value) {
      const expiresAt = Date.now() + ttlMs
      const store = scopedStore()
      if (store) {
        // Keys are fresh random ids, so a plain insert is enough.
        if ((await store.compareAndSet(storeKey(key), JSON.stringify(schema.parse(value)), 0, expiresAt)) === null) {
          throw new Error(`${namespace} key already in use`)
        }
        return
      }
      memory.set(key, { value, expiresAt })
    },
    async delete(key) {
      const store = scopedStore()
      if (store) await store.delete(storeKey(key))
      else memory.delete(key)
    },
  }
}
