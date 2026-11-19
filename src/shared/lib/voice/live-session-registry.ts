/**
 * This process's part of a Live session's life: admitting a start, hanging up
 * the provider's side, retrying a hangup that failed, and the last hangup at
 * the session's deadline.
 *
 * Which sessions a user holds, and which of them count toward the limit, is
 * AppState's (`live-session-admission.ts`), so a release can reach any
 * process. Each session this process created or was asked to close has one
 * wakeup on the TaskManager, for its deadline or its next retry. With the local
 * manager that wakeup is in this process's memory: when the process goes away,
 * its retries and deadline hangups go with it, and its sessions only stop
 * counting at their deadlines.
 */
import { z } from 'zod'
import { background } from '../background'
import { Task, taskManager, type TaskManager, type TaskResult } from '../background-work'
import { getRequestUserId, runWithOptionalUser } from '../platform-attribution/request-context'
import {
  activateLiveSession,
  cancelLiveSessionReservation,
  closeLiveSessionEntry,
  LIVE_SESSION_MAX_MS,
  LIVE_SESSION_PENDING_LEASE_MS,
  LIVE_SESSION_RETAIN_MS,
  removeLiveSession,
  renewLiveSessionReservation,
  reserveLiveSession,
} from './live-session-admission'
import type { VoiceProvider } from './provider-types'

export { LIVE_SESSION_MAX_MS, LIVE_SESSION_PENDING_LEASE_MS, LIVE_SESSION_RETAIN_MS } from './live-session-admission'

const RETRY_DELAYS_MS = [1000, 5000, 30_000]
/**
 * Between attempts to remove a hung-up session's entry while AppState refuses
 * the write; the last delay repeats until the session's deadline, when the
 * entry stops counting by itself.
 */
const REMOVAL_RETRY_DELAYS_MS = [1000, 5000, 30_000, 60_000]
/** How often a start in progress renews its reservation; several renewals fit in one lease. */
const LIVE_SESSION_RENEW_MS = LIVE_SESSION_PENDING_LEASE_MS / 4

/**
 * Hangs up a provider's session, with that provider's key as it is configured
 * now. A session is always hung up through the provider that created it.
 */
export type LiveSessionHangup = (provider: VoiceProvider, providerSessionId: string) => Promise<void>

export type LiveSessionRelease = 'missing' | 'closed' | 'closing'

export interface StartedLiveSession {
  /** What the client releases the session with: the reservation's id. */
  handle: string
  expiresAt: number
}

/** A place among the user's four, held while the provider creates the session. */
export interface LiveSessionReservation {
  readonly id: string
  /**
   * The provider created the session: it becomes active and counts until its
   * deadline. Null when the reservation was cancelled or ran out first; the
   * session just created is then hung up (the first attempt is awaited) and
   * nothing is recorded for it. Throws, after the same hangup, when recording
   * the session fails.
   */
  start(providerSessionId: string): Promise<StartedLiveSession | null>
  /**
   * Stops renewing, and frees the place unless the session started. Call it
   * when the start ends however it ends; it is also how a cancelled request
   * gives up its place early. Idempotent, and never rejects: a reservation it
   * could not free runs out with its lease.
   */
  end(): Promise<void>
}

/** A session this process knows about: it created it, or was asked to close it. */
interface LocalSession {
  owner: string
  provider: VoiceProvider
  providerSessionId: string
  expiresAt: number
  /**
   * Whether AppState may hold an entry for it, to remove once it is hung up.
   * False only when its reservation was known to be gone before activation.
   */
  recorded: boolean
  /**
   * Who the request that brought it here acted as. A hangup at a later wakeup
   * goes out as the same user, whose attribution a platform-billed provider needs.
   */
  actingUserId?: string
  attempts: number
  /** When the next hangup retry is due, while any are left. */
  retryAt?: number
  /** Hung up, or given up on: only its entry is left to remove. `at` is Infinity while a removal is in flight. */
  removal?: { failures: number; at: number }
  pending?: Promise<boolean>
}

const hangUpCallPayloadSchema = z.object({ callId: z.string() })
type HangUpCallPayload = z.infer<typeof hangUpCallPayloadSchema>

const HANG_UP_TASK_TYPE = 'voice.hangup'

function hangUpJobId(callId: string): string {
  return `hangup:${callId}`
}

/**
 * A session's wakeup came due. The registry sets the next one as the session's
 * state changes, on this path and on a release's alike, so the task only says
 * which session to look at.
 */
class HangUpCallTask extends Task<HangUpCallPayload> {
  readonly type = HANG_UP_TASK_TYPE
  readonly payloadSchema = hangUpCallPayloadSchema

  constructor(private readonly due: (callId: string) => Promise<void>) {
    super()
  }

  async execute({ callId }: HangUpCallPayload): Promise<TaskResult<HangUpCallPayload>> {
    await this.due(callId)
    return { kind: 'done' }
  }
}

export class LiveSessionRegistry {
  // Process-local: what is due for each session and its in-flight hangup, keyed by handle.
  private readonly sessions = new Map<string, LocalSession>()
  // Releases in flight, so concurrent releases of one session hang it up once.
  private readonly releases = new Map<string, Promise<LiveSessionRelease>>()
  /** For the app's task catalog: this registry's sessions wake through it. */
  readonly hangUpTask = new HangUpCallTask((callId) => this.wake(callId))

  constructor(
    private readonly hangup: LiveSessionHangup,
    private readonly tasks: () => TaskManager = taskManager,
  ) {}

  /** Admits a start for `owner`, or null when four sessions are already pending or active. */
  async reserve(owner: string, provider: VoiceProvider): Promise<LiveSessionReservation | null> {
    const reservation = await reserveLiveSession(owner, provider)
    if (!reservation) return null
    const { id } = reservation
    let ended = false
    let started = false
    const renewal = setInterval(() => background(async () => {
      if (!await renewLiveSessionReservation(owner, id)) clearInterval(renewal)
    }, { name: 'live-session-registry.renew-reservation' }), LIVE_SESSION_RENEW_MS)
    renewal.unref()
    return {
      id,
      start: async (providerSessionId) => {
        let active: { expiresAt: number } | null = null
        try {
          // A reservation given up already is not started, even if its cancel has not landed yet.
          if (!ended) active = await activateLiveSession(owner, id, providerSessionId)
        } catch (error) {
          // The client gets no handle, so nobody could release it: hang it up
          // now rather than let it bill. The activation may have landed all
          // the same (its answer lost), leaving an active entry that counts,
          // so it is treated as recorded: its entry is removed after the
          // hangup, retried until that works.
          await this.abandon(owner, id, provider, providerSessionId, true)
          throw new Error('Could not record the voice session. Try again.', { cause: error })
        }
        if (!active) {
          await this.abandon(owner, id, provider, providerSessionId, false)
          return null
        }
        started = true
        clearInterval(renewal)
        this.track(id, { owner, provider, providerSessionId, expiresAt: active.expiresAt, recorded: true })
        return { handle: id, expiresAt: active.expiresAt }
      },
      end: async () => {
        if (ended) return
        ended = true
        clearInterval(renewal)
        if (started) return
        try {
          await cancelLiveSessionReservation(owner, id)
        } catch (error) {
          console.warn('[voice] Could not free a Live session reservation; it runs out with its lease:', error)
        }
      },
    }
  }

  /**
   * Closes `owner`'s session `handle` from any process: it stops counting at
   * once, then the provider is asked to hang it up. `closed` once the hangup
   * succeeded; `closing` while it is retried here.
   */
  release(handle: string, owner: string): Promise<LiveSessionRelease> {
    const key = JSON.stringify([owner, handle])
    let release = this.releases.get(key)
    if (!release) {
      release = this.close(handle, owner).finally(() => this.releases.delete(key))
      this.releases.set(key, release)
    }
    return release
  }

  private async close(handle: string, owner: string): Promise<LiveSessionRelease> {
    const entry = await closeLiveSessionEntry(owner, handle)
    if (!entry) return 'missing'
    const known = this.sessions.get(handle)
    const session = known?.owner === owner
      ? known
      : this.track(handle, { owner, provider: entry.provider, providerSessionId: entry.providerSessionId, expiresAt: entry.expiresAt, recorded: true })
    return await this.attempt(handle, session) ? 'closed' : 'closing'
  }

  /**
   * Hangs up a session the client will not get: its reservation was gone by
   * the time the provider created it, or recording it failed. `recorded`: it
   * may have an entry to remove once it is hung up.
   */
  private async abandon(owner: string, handle: string, provider: VoiceProvider, providerSessionId: string, recorded: boolean): Promise<void> {
    const session = this.track(handle, { owner, provider, providerSessionId, expiresAt: Date.now() + LIVE_SESSION_MAX_MS, recorded })
    await this.attempt(handle, session)
  }

  /** Keeps a session here, with its deadline hangup. */
  private track(handle: string, fields: Pick<LocalSession, 'owner' | 'provider' | 'providerSessionId' | 'expiresAt' | 'recorded'>): LocalSession {
    const session: LocalSession = { ...fields, actingUserId: getRequestUserId(), attempts: 0 }
    const replaced = this.sessions.get(handle)
    if (replaced) this.drop(handle, replaced)
    this.sessions.set(handle, session)
    this.arm(handle, session)
    return session
  }

  /**
   * Sets the session's one wakeup for what is next due: a removal retry once it
   * is hung up, otherwise its next hangup retry or its deadline, whichever is
   * first. Calling this again moves the wakeup.
   */
  private arm(handle: string, session: LocalSession): void {
    if (this.sessions.get(handle) !== session) return
    const at = session.removal?.at ?? Math.min(session.retryAt ?? Infinity, session.expiresAt)
    if (at === Infinity) {
      background(this.tasks().cancel(hangUpJobId(handle)), { name: 'live-session-registry.cancel-wakeup' })
      return
    }
    background(this.tasks().at(at, hangUpJobId(handle), { taskType: HANG_UP_TASK_TYPE, payload: { callId: handle } }), { name: 'live-session-registry.set-wakeup' })
  }

  /** A session's wakeup came due: whatever is due for it now, as whoever brought it here. */
  private async wake(handle: string): Promise<void> {
    const session = this.sessions.get(handle)
    if (!session) return
    await runWithOptionalUser(session.actingUserId, async () => {
      const now = Date.now()
      if (session.removal) {
        // Past the deadline, the entry no longer counts.
        if (now >= session.expiresAt || await this.removeEntry(handle, session, session.removal.failures)) this.drop(handle, session)
      } else if (now >= session.expiresAt) {
        await this.expire(handle, session)
      } else if (session.retryAt !== undefined && now >= session.retryAt) {
        await this.attempt(handle, session)
      } else {
        // An attempt took over this retry while the wakeup came due.
        this.arm(handle, session)
      }
    })
  }

  /**
   * The deadline: one last hangup, and the session is forgotten whatever its
   * outcome. Skipped only when the entry is gone from AppState while it would
   * still be kept, which means another process hung it up and removed it.
   * Whenever that is not certain, it hangs up: a second hangup of an ended
   * session does no harm (the provider answers 404, which counts as closed).
   */
  private async expire(handle: string, session: LocalSession): Promise<void> {
    if (session.recorded) {
      let entry: Awaited<ReturnType<typeof closeLiveSessionEntry>> | undefined
      try {
        entry = await closeLiveSessionEntry(session.owner, handle)
      } catch (error) {
        console.warn('[voice] Could not read a Live session at its deadline; hanging it up anyway:', error)
      }
      // A timer delayed past the entry's keeping (a machine asleep) finds it
      // gone either way, so its absence says nothing then.
      if (entry === null && Date.now() < session.expiresAt + LIVE_SESSION_RETAIN_MS) {
        this.drop(handle, session)
        return
      }
    }
    await this.attempt(handle, session, true)
  }

  private attempt(handle: string, session: LocalSession, final = false): Promise<boolean> {
    if (session.pending) return session.pending
    session.retryAt = undefined
    const pending = (async () => this.hangup(session.provider, session.providerSessionId))().then(async () => {
      await this.forget(handle, session)
      return true
    }, async () => {
      if (final || Date.now() >= session.expiresAt) {
        await this.forget(handle, session)
        console.warn('Live session cleanup failed at expiry')
      } else {
        const delay = RETRY_DELAYS_MS[session.attempts++]
        // After bounded retries, the wakeup at the deadline makes a final attempt.
        session.retryAt = delay === undefined ? undefined : Date.now() + delay
        this.arm(handle, session)
      }
      return false
    }).finally(() => { session.pending = undefined })
    session.pending = pending
    return pending
  }

  /**
   * The session is done with: hung up, or given up at its deadline. Its entry
   * is removed; when AppState refuses, the removal is retried here, since the
   * entry may still be active and counting (an activation whose answer was
   * lost), until it works or the deadline ends the entry's count anyway.
   */
  private async forget(handle: string, session: LocalSession): Promise<void> {
    session.retryAt = undefined
    if (session.recorded) {
      session.removal = { failures: 0, at: Infinity }
      this.arm(handle, session)
      if (!await this.removeEntry(handle, session, 0)) return
    }
    this.drop(handle, session)
  }

  /** One removal of the session's entry; on failure, schedules the next one. True once removed. */
  private async removeEntry(handle: string, session: LocalSession, failures: number): Promise<boolean> {
    try {
      await removeLiveSession(session.owner, handle)
      return true
    } catch (error) {
      if (failures === 0) console.warn('[voice] Could not remove a hung-up Live session from AppState; retrying:', error)
    }
    const delay = REMOVAL_RETRY_DELAYS_MS[Math.min(failures, REMOVAL_RETRY_DELAYS_MS.length - 1)]
    session.removal = { failures: failures + 1, at: Date.now() + delay }
    this.arm(handle, session)
    return false
  }

  private drop(handle: string, session: LocalSession): void {
    if (this.sessions.get(handle) !== session) return
    this.sessions.delete(handle)
    background(this.tasks().cancel(hangUpJobId(handle)), { name: 'live-session-registry.cancel-wakeup' })
  }
}
