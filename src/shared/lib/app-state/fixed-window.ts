/**
 * Fixed-window rate limits over a strong AppState counter. A key admits at
 * most `limit` hits in a window that starts at its first hit and ends
 * `windowMs` later, however many hits arrive in between: hits never move the
 * end (the window does not slide). Each hit is one atomic bounded increment,
 * so competing requests can neither lose a hit nor both take the last place.
 */
import { z } from 'zod'
import { appState } from './app-state'
import type { Namespace, StateKey } from './contract'
import { defineNamespace } from './definitions'

export interface FixedWindowDefinition {
  /** The counters' namespace name, such as `rate:auth`. */
  name: string
  /** Hits admitted per key and window. */
  limit: number
  /** How long a window lasts from the hit that opens it. */
  windowMs: number
}

export interface FixedWindowHit {
  /** Whether the hit is within the limit. A refused hit is not counted. */
  readonly admitted: boolean
  /** Hits admitted in the key's current window, this one included when admitted. */
  readonly count: number
  /** Hits the window still admits. */
  readonly remaining: number
  /** Epoch ms at which the window ends and the key admits `limit` hits again. */
  readonly resetAt: number
}

export interface FixedWindow {
  /** The counters, for reading one in a test. Only `hit` writes them. */
  readonly namespace: Namespace<number, 'strong'>
  readonly limit: number
  readonly windowMs: number
  /** The key for these parts. Pass an identifier (an IP, an email) through `digestKeyPart` first. */
  key(...parts: string[]): StateKey<number, 'strong'>
  /** Counts a hit against `key` if its window has room, and says whether it did. */
  hit(key: StateKey<number, 'strong'>): Promise<FixedWindowHit>
}

export function defineFixedWindow(definition: FixedWindowDefinition): FixedWindow {
  const { name, limit, windowMs } = definition
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`${name}: a fixed window admits at least one hit`)
  const namespace = defineNamespace({
    name,
    consistency: 'strong',
    schema: z.number().int().min(0),
    // `keep`: a hit leaves the window's end where the first hit put it, so a
    // burst near the end of a window does not extend it.
    expiry: { ttlMs: windowMs, onUpdate: 'keep' },
  })
  const window: FixedWindow = {
    namespace,
    limit,
    windowMs,
    key: (...parts) => namespace.key(...parts),
    async hit(key) {
      if (key.namespace !== namespace) throw new TypeError(`${name}: the key belongs to ${key.namespace.name}`)
      // One operation: an absent or expired counter opens a window at 1, a
      // live one counts on up to `limit`, and a full one refuses the hit
      // without counting it or moving its end.
      const result = await appState().increment(key, 1, { max: limit })
      const entry = result.applied ? result.entry : result.current
      // Only `hit` writes the namespace, always with its TTL; with `limit` of
      // at least 1, a refused increment always finds a live counter.
      if (!entry || entry.expiresAt === null) throw new Error(`${key.path}: a fixed-window counter has no window`)
      return {
        admitted: result.applied,
        count: entry.value,
        remaining: Math.max(0, limit - entry.value),
        resetAt: entry.expiresAt,
      }
    },
  }
  return Object.freeze(window)
}
