/**
 * A change to one strong record, decided from what it holds now: the
 * compare-and-set loop that a record with several writers needs. `reduce` is
 * called with the stored value and says what to write; the write lands only
 * while the record is still the write it was decided from, and after a
 * conflict `reduce` decides again from what is stored then. So no writer's
 * change is lost to another's, and none is decided from a stale read.
 */
import { appState } from './app-state'
import type { Expiry, StateKey } from './contract'

/**
 * What one decision writes, and what the caller gets back. Without `value`
 * nothing is written; `value: null` deletes the record. `expiry` overrides the
 * namespace's policy for this write.
 */
export type RecordChange<T, R> =
  | { readonly result: R }
  | { readonly result: R; readonly value: T; readonly expiry?: Expiry }
  | { readonly result: R; readonly value: null }

export interface ReduceRecordOptions {
  /**
   * Decisions before giving up. Each conflict means another write landed, so
   * only that many writers at once exhaust it. Default 64.
   */
  readonly maxAttempts?: number
}

const DEFAULT_MAX_ATTEMPTS = 64

/**
 * Applies `reduce` to the record at `key` (null when absent) and writes what
 * it decides, conditionally on the revision it read; on a conflict it reads
 * nothing again but decides from the `current` the conflict returned.
 *
 * `reduce` may run several times and only its last decision is written, so it
 * must not have side effects: do them with the result, after this resolves.
 * It reads the clock itself when it needs one, so each decision uses the time
 * it was made.
 */
export async function reduceRecord<T, R>(
  key: StateKey<T, 'strong'>,
  reduce: (current: T | null) => RecordChange<T, R>,
  options?: ReduceRecordOptions,
): Promise<R> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  let current = await appState().get(key)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const change = reduce(current?.value ?? null)
    if (!('value' in change)) return change.result
    if (change.value === null) {
      if (!current) return change.result
      const deleted = await appState().consume(key, { revision: current.revision })
      if (deleted.consumed) return change.result
      current = deleted.current
      continue
    }
    const written = await appState().compareAndSet(key, current?.revision ?? null, change.value, 'expiry' in change && change.expiry ? { expiry: change.expiry } : undefined)
    if (written.ok) return change.result
    current = written.current
  }
  throw new Error(`AppState ${key.path} changed under ${maxAttempts} updates in a row`)
}
