/**
 * Failure lockouts over a strong AppState record: the failures against a key
 * (an account) are counted until a success clears them, and the failure that
 * reaches the threshold locks the key for a while. Every change is a
 * conditional write against the revision it was decided from, so competing
 * failures are all counted and a success clears only the failures it saw.
 *
 * The record has no expiry. Failures below the threshold last until a
 * success clears them; a lock that has run out is cleared, with the failures
 * that set it, by the next check.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { appState } from './app-state'
import type { Entry, Namespace, Revision, StateKey } from './contract'
import { defineNamespace } from './definitions'

export interface LockoutPolicy {
  /** Failures at which the key locks. Read at each call, so a changed setting applies at once. */
  readonly threshold: number
  /** How long a lock lasts from the failure that sets it. */
  readonly lockMs: number
}

const lockoutRecordSchema = z.object({
  /** Failures counted and not yet cleared. */
  failures: z.number().int().min(1),
  /** Epoch ms (this process's clock) the lock lasts until; null while the key has never reached the threshold. */
  lockedUntil: z.number().nullable(),
  /**
   * Names this run of failures, so a success that saw an earlier state of the
   * same record can take away exactly the failures it saw, and never touches
   * a record created after it was cleared.
   */
  run: z.string().min(1),
})

export type LockoutRecord = z.infer<typeof lockoutRecordSchema>

/** What a check saw, for `succeeded` to clear. */
export interface LockoutObservation {
  readonly revision: Revision
  readonly run: string
  readonly failures: number
}

export interface LockedStatus {
  readonly locked: true
  readonly failures: number
  readonly lockedUntil: number
}

export interface UnlockedStatus {
  readonly locked: false
  /** Failures counted, below the threshold. */
  readonly failures: number
  /** The write the check decided from; null when nothing was counted. */
  readonly observed: LockoutObservation | null
}

export type LockoutStatus = LockedStatus | UnlockedStatus

export interface Lockout {
  /** The records, for reading one in a test. Only this helper writes them. */
  readonly namespace: Namespace<LockoutRecord, 'strong'>
  /** The key for these parts. Pass an identifier (an email) through `digestKeyPart` first. */
  key(...parts: string[]): StateKey<LockoutRecord, 'strong'>
  /**
   * Whether `key` is locked now. A lock that has run out is cleared here, so
   * the key starts counting again.
   */
  check(key: StateKey<LockoutRecord, 'strong'>, policy: LockoutPolicy): Promise<LockoutStatus>
  /** Counts a failure; the one that reaches `threshold`, and each after it, locks the key for `lockMs`. */
  failed(key: StateKey<LockoutRecord, 'strong'>, policy: LockoutPolicy): Promise<LockoutRecord>
  /**
   * Clears the failures an unlocked `check` saw. Failures counted after that
   * check stay, so a success that raced a failure does not erase it.
   */
  succeeded(key: StateKey<LockoutRecord, 'strong'>, status: UnlockedStatus): Promise<void>
}

export function defineLockout(definition: { name: string }): Lockout {
  const namespace = defineNamespace({
    name: definition.name,
    consistency: 'strong',
    schema: lockoutRecordSchema,
    expiry: { ttlMs: null, onUpdate: 'keep' },
  })

  function assertOwn(key: StateKey<LockoutRecord, 'strong'>): void {
    if (key.namespace !== namespace) throw new TypeError(`${namespace.name}: the key belongs to ${key.namespace.name}`)
  }

  const observe = (entry: Entry<LockoutRecord>): LockoutObservation => ({
    revision: entry.revision,
    run: entry.value.run,
    failures: entry.value.failures,
  })

  const lockout: Lockout = {
    namespace,
    key: (...parts) => namespace.key(...parts),

    async check(key, policy) {
      assertOwn(key)
      let entry = await appState().get(key)
      // Each pass decides from one write; a write that lands before the
      // conditional clear makes it fail, and the next pass decides from that.
      for (;;) {
        if (!entry) return { locked: false, failures: 0, observed: null }
        const { failures, lockedUntil } = entry.value
        if (failures < policy.threshold) return { locked: false, failures, observed: observe(entry) }
        if (lockedUntil !== null && Date.now() < lockedUntil) return { locked: true, failures, lockedUntil }
        // At the threshold, but the lock has run out (or was never set, when
        // the threshold has since been lowered): start counting again.
        const cleared = await appState().consume(key, { revision: entry.revision })
        if (cleared.consumed) return { locked: false, failures: 0, observed: null }
        entry = cleared.current
      }
    },

    async failed(key, policy) {
      assertOwn(key)
      let current = await appState().get(key)
      // Lock-free: a conflict means another write landed, and this one is
      // retried on top of it, so no failure is lost.
      for (;;) {
        const failures = (current?.value.failures ?? 0) + 1
        const next: LockoutRecord = {
          failures,
          lockedUntil: failures >= policy.threshold ? Date.now() + policy.lockMs : (current?.value.lockedUntil ?? null),
          run: current?.value.run ?? randomUUID(),
        }
        const result = await appState().compareAndSet(key, current?.revision ?? null, next)
        if (result.ok) return result.entry.value
        current = result.current
      }
    },

    async succeeded(key, status) {
      assertOwn(key)
      const seen = status.observed
      // Nothing counted at the check: whatever is counted now came after it.
      if (!seen) return
      let result = await appState().consume(key, { revision: seen.revision })
      for (;;) {
        if (result.consumed) return
        const current = result.current
        // Cleared already, or counting a run that started after it was: none
        // of these failures are the ones this success saw.
        if (!current || current.value.run !== seen.run) return
        // The same run with failures counted since the check: take away the
        // ones the check saw and keep the rest.
        const failures = current.value.failures - seen.failures
        if (failures <= 0) {
          result = await appState().consume(key, { revision: current.revision })
          continue
        }
        const kept = await appState().compareAndSet(key, current.revision, { ...current.value, failures })
        if (kept.ok) return
        result = { consumed: false, current: kept.current }
      }
    },
  }
  return Object.freeze(lockout)
}
