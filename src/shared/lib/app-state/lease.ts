/**
 * Owned leases over a strong AppState record: at most one owner holds a key at
 * a time, until it releases the key or `ttlMs` passes without a renewal. Each
 * acquisition is a new owner with a random id, and the revision of its last
 * write is its fence: a renewal or a release is a conditional write against
 * that revision, so an owner whose lease lapsed can neither extend nor delete
 * a successor's.
 *
 * What a holder knows, it knows by its own clock. It reads `Date.now()` before
 * it sends an acquire or a renewal; the backend can only have written the lease
 * after that, so the lease is surely held until `sent + ttlMs` (`heldUntil`),
 * whatever the backend's clock says. A response that arrives at or after that
 * instant proves nothing: the write is treated as not held (and released, if it
 * is still there), however it was answered. The backend's own expiry is never
 * compared with this process's clock, so clock skew between them plays no part.
 *
 * A lease serializes work among the processes that ask for it. It cannot reach
 * outside AppState: a request a holder already sent runs on after its lease
 * lapses, and a write it makes elsewhere (the database, a provider) is fenced
 * only by that write's own condition. `hold` gives work a signal that aborts
 * when the lease is lost, at the latest at `heldUntil`, and `confirm()`, which
 * renews and resolves only if the lease is then held for at least a given
 * time: call it right before a request or write only the holder may make, with
 * that request's timeout, so the request cannot outlive the lease.
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
  /**
   * Epoch ms by this process's clock until which the lease is surely held:
   * when the acquire or renewal that wrote it was sent, plus `ttlMs`.
   */
  readonly heldUntil: number
}

/** The lease was not this holder's any more, or not for long enough. */
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

export interface ConfirmOptions {
  /**
   * How long the lease must still be held when `confirm` resolves, by this
   * process's clock. Pass the timeout of the request about to be sent, or a
   * margin for the write about to be made. Default 0: held now.
   */
  readonly minRemainingMs?: number
}

/** What `hold` gives its work. */
export interface LeaseHolding {
  readonly owner: string
  /**
   * Aborts, with a `LeaseLostError`, once a renewal finds the lease lost, is
   * answered too late or fails, and at the latest when the lease runs out
   * without a renewal.
   */
  readonly signal: AbortSignal
  /**
   * Renews the lease now. Resolves only if the renewal is answered in time and
   * the lease is then held for at least `minRemainingMs` more; otherwise aborts
   * the signal and throws `LeaseLostError`. Call it right before a request or
   * write that only the holder may make, with nothing awaited in between.
   */
  confirm(options?: ConfirmOptions): Promise<void>
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
  /** Takes the lease when nobody holds it. Null while another owner does, or when the answer came too late to rely on. */
  acquire(key: StateKey<LeaseRecord, 'strong'>): Promise<HeldLease | null>
  /** Extends the lease to `ttlMs` from now. Null when it is not this holder's any more, or the answer came too late. */
  renew(lease: HeldLease): Promise<HeldLease | null>
  /** Ends the lease if it is still this holder's, and says whether it was. Never touches a successor's. */
  release(lease: HeldLease): Promise<boolean>
  /**
   * Runs `work` while holding `lease`: renews it every `renewEveryMs`, aborts
   * the holding's signal once the lease is lost, and releases it when the work
   * settles. The work's result or error is returned as is.
   */
  hold<T>(lease: HeldLease, work: (holding: LeaseHolding) => Promise<T>): Promise<T>
  /**
   * Acquires `key`, waiting while another owner holds it: tries again with a
   * short backoff (50 ms doubling to 1 s) until the lease is free, `whileWaiting`
   * ends the wait, or `timeoutMs` passes.
   */
  acquireWhenFree<R = never>(key: StateKey<LeaseRecord, 'strong'>, wait: LeaseWait<R>): Promise<LeaseWaitResult<R>>
}

/**
 * How `holdRenewing` keeps a record held. `renew` writes the renewal and says
 * how long it holds now, or null when it is lost. `release` gives the record up;
 * it can be called twice, when a confirm gives up early.
 */
export interface RenewableHold<H extends { readonly heldUntil: number }> {
  readonly owner: string
  /** Names the record in errors. */
  readonly label: string
  readonly renewEveryMs: number
  renew(current: H): Promise<H | null>
  release(current: H): Promise<unknown>
}

/**
 * `Lease.hold`, for a helper whose record is not one lease per key: runs `work`
 * while the record stays held. Renews every `renewEveryMs`, one renewal at a
 * time, aborts the holding's signal once the record is lost or `heldUntil`
 * passes unrenewed, and releases it when the work settles. The work's result or
 * error is returned as is.
 */
export async function holdRenewing<H extends { readonly heldUntil: number }, T>(
  initial: H,
  hold: RenewableHold<H>,
  work: (holding: LeaseHolding) => Promise<T>,
): Promise<T> {
  const { label, renewEveryMs } = hold
  const controller = new AbortController()
  let current = initial
  const lose = (error: LeaseLostError) => {
    if (!controller.signal.aborted) controller.abort(error)
  }
  // Lost at the latest when the lease runs out unrenewed, even if a
  // renewal never answers.
  let runsOut: ReturnType<typeof setTimeout> | undefined
  const watchDeadline = () => {
    clearTimeout(runsOut)
    runsOut = setTimeout(() => lose(new LeaseLostError(`${label}: the lease ran out unrenewed`)), Math.max(0, current.heldUntil - Date.now()))
    runsOut.unref?.()
  }
  watchDeadline()
  // One renewal at a time: two renewals racing from the same revision would
  // see the second fail against the first's write and report a false loss.
  let renewals: Promise<boolean> = Promise.resolve(true)
  const renewNow = (): Promise<boolean> => {
    renewals = renewals.then(async () => {
      if (controller.signal.aborted) return false
      try {
        const renewed = await hold.renew(current)
        if (renewed) {
          // Kept even when the deadline passed meanwhile, so the release
          // at the end frees this write instead of leaving it to lapse.
          current = renewed
          if (controller.signal.aborted) return false
          watchDeadline()
          return true
        }
        lose(new LeaseLostError(`${label}: the lease lapsed, was taken, or was renewed too late to rely on`))
      } catch (error) {
        // Unconfirmed is lost: the holder stops rather than act on a lease
        // it cannot vouch for.
        lose(new LeaseLostError(`${label}: the lease could not be renewed`, { cause: error }))
      }
      return false
    })
    return renewals
  }
  // renewNow never rejects: a failed renewal aborts the holding's signal.
  const timer = setInterval(() => background(renewNow(), { name: 'app-state.lease-renew' }), renewEveryMs)
  timer.unref?.()
  const holding: LeaseHolding = {
    owner: hold.owner,
    signal: controller.signal,
    async confirm(options = {}) {
      const minRemainingMs = options.minRemainingMs ?? 0
      if (!(await renewNow())) throw controller.signal.reason
      const remaining = current.heldUntil - Date.now()
      if (remaining <= 0 || remaining < minRemainingMs) {
        lose(new LeaseLostError(`${label}: ${remaining} ms of the lease left, ${minRemainingMs} ms needed`))
        // Given up at once rather than when the work settles, so whoever
        // takes over (this process's own retry, too) need not wait it out.
        await hold.release(current).catch(() => false)
        throw controller.signal.reason
      }
    },
  }
  try {
    return await work(holding)
  } finally {
    clearInterval(timer)
    clearTimeout(runsOut)
    await renewals
    // Owner-checked by each helper, so a successor's lease is never touched.
    // A failed release leaves the lease to lapse on its own.
    await hold.release(current).catch(() => false)
  }
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

  /**
   * The lease a write answered at `sentAt` gives, or null when the answer came
   * at or after the instant it was surely held until: the write is released,
   * if it is still there, rather than relied on.
   */
  async function inTime(key: StateKey<LeaseRecord, 'strong'>, entry: Entry<LeaseRecord>, sentAt: number): Promise<HeldLease | null> {
    const written: HeldLease = { key, owner: entry.value.owner, revision: entry.revision, heldUntil: sentAt + ttlMs }
    if (Date.now() < written.heldUntil) return written
    await lease.release(written).catch(() => false)
    return null
  }

  const lease: Lease = {
    namespace,
    ttlMs,
    renewEveryMs,
    key: (...parts) => namespace.key(...parts),

    async acquire(key) {
      assertOwn(key)
      const sentAt = Date.now()
      const result = await appState().insertIfAbsent(key, { owner: randomUUID() }, { expiry: { ttlMs } })
      return result.inserted ? inTime(key, result.entry, sentAt) : null
    },

    async renew(current) {
      assertOwn(current.key)
      const sentAt = Date.now()
      // Conditional on the holder's last write: a lapsed lease's revision never
      // matches again, even when the key has been taken since.
      const result = await appState().compareAndSet(current.key, current.revision, { owner: current.owner }, { expiry: { ttlMs } })
      return result.ok ? inTime(current.key, result.entry, sentAt) : null
    },

    async release(current) {
      assertOwn(current.key)
      return (await appState().consume(current.key, { revision: current.revision })).consumed
    },

    async hold(initial, work) {
      assertOwn(initial.key)
      return await holdRenewing(initial, { owner: initial.owner, label: initial.key.path, renewEveryMs, renew: lease.renew, release: lease.release }, work)
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
