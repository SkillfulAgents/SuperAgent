import { currentStore } from './scope'

/** At most `limit` hits per key in a fixed window of `windowMs`. */
export function windowLimiter(namespace: string, limit: number, windowMs: number) {
  return {
    /** Counts the hit; false once the key is over its limit for this window. */
    async hit(key: string): Promise<boolean> {
      const { count } = await currentStore().hitWindow(`${namespace}:${key}`, windowMs)
      return count <= limit
    },
  }
}

/** Failed attempts per key, and the lock they earn at a threshold. */
export function lockoutCounter(namespace: string) {
  const storeKey = (key: string) => `${namespace}:${key}`
  return {
    /** When the key is locked, until when; null when it is not. */
    async lockedUntil(key: string, threshold: number): Promise<number | null> {
      const entry = await currentStore().get(storeKey(key))
      if (!entry || Number(entry.value) < threshold || !entry.expiresAt) return null
      return entry.expiresAt
    },
    async fail(key: string, threshold: number, lockMs: number): Promise<void> {
      await currentStore().recordFailure(storeKey(key), threshold, lockMs)
    },
    async clear(key: string): Promise<void> {
      await currentStore().delete(storeKey(key))
    },
  }
}
