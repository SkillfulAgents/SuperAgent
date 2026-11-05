/**
 * Owned leases over a strong AppState record: at most one owner holds a key at
 * a time, until it releases the key or `ttlMs` passes without a renewal. Each
 * acquisition is a new owner with a random id, and the revision of its last
 * write is its fence: a renewal or a release is a conditional write against
 * that revision, so an owner whose lease lapsed can neither extend nor delete
 * a successor's.
 *
 * A lease serializes work among the processes that ask for it. It cannot
 * reach outside AppState: a request a holder already sent runs on after its
 * lease lapses, and a write it makes elsewhere (the database, a provider) is
 * fenced only by that write's own condition. `hold` gives work a signal that
 * aborts when the lease is found lost, and `confirm()` to check it right
 * before a write only the holder may make.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { background } from '../background'
import { appState } from './app-state'
import type { Entry, Namespace, Revision, StateKey } from './contract'
import { defineNamespace } from './definitions'

const leaseRecordSchema = z.object({
  /** This acquisition's owner: a fresh random id each time, even within one process. */
  owner: z.string().min(1),
})

export type LeaseRecord = z.infer<typeof leaseRecordSchema>

export interface LeaseDefinition {
  /** The leases' namespace name, such as `claim:github-token`. */
  name: string
  /** How long a lease lasts from its acquisition or last renewal. */
  ttlMs: number
  /** How often `hold` renews while its work runs. Default: a third of `ttlMs`. */
  renewEveryMs?: number
}

/** A lease as its holder last wrote it. */
export interface HeldLease {
  readonly key: StateKey<LeaseRecord, 'strong'>
  readonly owner: string
  /** The fence: this holder's last write. Renewal and release are conditional on it. */
  readonly revision: Revision
  /** Epoch ms (the AppState clock) at which the lease lapses unless renewed. */
  readonly expiresAt: number
}

/** The lease was not this holder's any more: it lapsed, or a renewal could not be confirmed. */
export class LeaseLostError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LeaseLostError'
  }
}

/** Another owner held the lease for longer than the caller would wait. */
export class LeaseWaitTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LeaseWaitTimeoutError'
  }
}

/** What `hold` gives its work. */
export interface LeaseHolding {
  readonly owner: string
  /** Aborts, with a `LeaseLostError`, once a renewal finds the lease lost or cannot confirm it. */
  readonly signal: AbortSignal
  /**
   * Renews the lease now and throws `LeaseLostError` if it is no longer held.
   * Call it right before a write that only the holder may make.
   */
  confirm(): Promise<void>
}

export interface LeaseWait<R> {
  /** How long to wait for another owner's lease to end; then `LeaseWaitTimeoutError`. */
  readonly timeoutMs: number
  /**
   * Called between attempts while another owner holds the lease. A result
   * other than undefined ends the wait without the lease (the work was done
   * elsewhere); a throw ends it too.
   */
  readonly whileWaiting?: () => Promise<R | undefined>
  readonly signal?: AbortSignal
}

export type LeaseWaitResult<R> =
  | { readonly acquired: true; readonly lease: HeldLease }
  | { readonly acquired: false; readonly result: R }

export interface Lease {
  /** The lease records, for reading one in a test. Only this helper writes them. */
  readonly namespace: Namespace<LeaseRecord, 'strong'>
  readonly ttlMs: number
  readonly renewEveryMs: number
  /** The key for these parts. Pass an identifier that must not appear in a key through `digestKeyPart` first. */
  key(...parts: string[]): StateKey<LeaseRecord, 'strong'>
  /** Takes the lease when nobody holds it; null while another owner does. */
  acquire(key: StateKey<LeaseRecord, 'strong'>): Promise<HeldLease | null>
  /** Extends the lease to `ttlMs` from now; null when it is not this holder's any more. */
  renew(lease: HeldLease): Promise<HeldLease | null>
  /** Ends the lease if it is still this holder's, and says whether it was. Never touches a successor's. */
  release(lease: HeldLease): Promise<boolean>
  /**
   * Runs `work` while holding `lease`: renews it every `renewEveryMs`, aborts
   * the holding's signal once a renewal finds it lost, and releases it when the
   * work settles. The work's result or error is returned as is.
   */
  hold<T>(lease: HeldLease, work: (holding: LeaseHolding) => Promise<T>): Promise<T>
  /**
   * Acquires `key`, waiting while another owner holds it: tries again with a
   * short backoff (50 ms doubling to 1 s) until the lease is free, `whileWaiting`
   * ends the wait, or `timeoutMs` passes.
   */
  acquireWhenFree<R = never>(key: StateKey<LeaseRecord, 'strong'>, wait: LeaseWait<R>): Promise<LeaseWaitResult<R>>
}

const FIRST_POLL_MS = 50
const LAST_POLL_MS = 1_000

export function defineLease(definition: LeaseDefinition): Lease {
  const { name, ttlMs } = definition
  const renewEveryMs = definition.renewEveryMs ?? Math.floor(ttlMs / 3)
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError(`${name}: a lease lasts a positive number of milliseconds`)
  if (!Number.isFinite(renewEveryMs) || renewEveryMs <= 0 || renewEveryMs >= ttlMs) {
    throw new RangeError(`${name}: a lease is renewed more often than it lapses`)
  }
  const namespace = defineNamespace({
    name,
    consistency: 'strong',
    schema: leaseRecordSchema,
    // Only `acquire` creates a record and only `renew` updates one, each with
    // its own expiry; `reset` matches what renew asks for.
    expiry: { ttlMs, onUpdate: 'reset' },
  })

  function assertOwn(key: StateKey<LeaseRecord, 'strong'>): void {
    if (key.namespace !== namespace) throw new TypeError(`${name}: the key belongs to ${key.namespace.name}`)
  }

  function held(key: StateKey<LeaseRecord, 'strong'>, entry: Entry<LeaseRecord>): HeldLease {
    if (entry.expiresAt === null) throw new Error(`${key.path}: a lease has no expiry`)
    return { key, owner: entry.value.owner, revision: entry.revision, expiresAt: entry.expiresAt }
  }

  const lease: Lease = {
    namespace,
    ttlMs,
    renewEveryMs,
    key: (...parts) => namespace.key(...parts),

    async acquire(key) {
      assertOwn(key)
      const result = await appState().insertIfAbsent(key, { owner: randomUUID() }, { expiry: { ttlMs } })
      return result.inserted ? held(key, result.entry) : null
    },

    async renew(current) {
      assertOwn(current.key)
      // Conditional on the holder's last write: a lapsed lease's revision never
      // matches again, even when the key has been taken since.
      const result = await appState().compareAndSet(current.key, current.revision, { owner: current.owner }, { expiry: { ttlMs } })
      return result.ok ? held(current.key, result.entry) : null
    },

    async release(current) {
      assertOwn(current.key)
      return (await appState().consume(current.key, { revision: current.revision })).consumed
    },

    async hold(initial, work) {
      assertOwn(initial.key)
      const controller = new AbortController()
      let current = initial
      const lose = (error: LeaseLostError) => {
        if (!controller.signal.aborted) controller.abort(error)
      }
      // One renewal at a time: two renewals racing from the same revision would
      // see the second fail against the first's write and report a false loss.
      let renewals: Promise<boolean> = Promise.resolve(true)
      const renewNow = (): Promise<boolean> => {
        renewals = renewals.then(async () => {
          if (controller.signal.aborted) return false
          try {
            const renewed = await lease.renew(current)
            if (renewed) {
              current = renewed
              return true
            }
            lose(new LeaseLostError(`${current.key.path}: the lease lapsed or was taken`))
          } catch (error) {
            // Unconfirmed is lost: the holder stops rather than act on a lease
            // it cannot vouch for.
            lose(new LeaseLostError(`${current.key.path}: the lease could not be renewed`, { cause: error }))
          }
          return false
        })
        return renewals
      }
      // renewNow never rejects: a failed renewal aborts the holding's signal.
      const timer = setInterval(() => background(renewNow(), { name: 'app-state.lease-renew' }), renewEveryMs)
      timer.unref?.()
      const holding: LeaseHolding = {
        owner: initial.owner,
        signal: controller.signal,
        async confirm() {
          if (!(await renewNow())) throw controller.signal.reason
        },
      }
      try {
        return await work(holding)
      } finally {
        clearInterval(timer)
        await renewals
        // A failed release leaves the lease to lapse on its own.
        if (!controller.signal.aborted) await lease.release(current).catch(() => false)
      }
    },

    async acquireWhenFree(key, wait) {
      assertOwn(key)
      const deadline = Date.now() + wait.timeoutMs
      let pause = FIRST_POLL_MS
      for (;;) {
        wait.signal?.throwIfAborted()
        const acquired = await lease.acquire(key)
        if (acquired) return { acquired: true, lease: acquired }
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new LeaseWaitTimeoutError(`${key.path}: another owner held the lease for over ${wait.timeoutMs} ms`)
        await sleep(Math.min(pause, remaining), wait.signal)
        pause = Math.min(pause * 2, LAST_POLL_MS)
        const result = await wait.whileWaiting?.()
        if (result !== undefined) return { acquired: false, result }
      }
    },
  }
  return Object.freeze(lease)
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
