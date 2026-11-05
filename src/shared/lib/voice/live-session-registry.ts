/**
 * This process's part of a Live session's life: admitting a start, hanging up
 * the provider's side, retrying a hangup that failed, and the last hangup at
 * the session's deadline.
 *
 * Which sessions a user holds, and which of them count toward the limit, is
 * AppState's (`live-session-admission.ts`), so a release can reach any
 * process. The timers here are this process's own, for the sessions it created
 * or was asked to close: when a process goes away, its retries and deadline
 * hangups go with it, and its sessions only stop counting at their deadlines.
 */
import { background } from '../background'
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
  attempts: number
  timer?: ReturnType<typeof setTimeout>
  retry?: ReturnType<typeof setTimeout>
  pending?: Promise<boolean>
}

export class LiveSessionRegistry {
  // Process-local: timers and in-flight hangups, keyed by handle.
  private readonly sessions = new Map<string, LocalSession>()
  // Releases in flight, so concurrent releases of one session hang it up once.
  private readonly releases = new Map<string, Promise<LiveSessionRelease>>()

  constructor(private readonly hangup: LiveSessionHangup) {}

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
    const session: LocalSession = { ...fields, attempts: 0 }
    session.timer = setTimeout(() => background(this.expire(handle, session), { name: 'live-session-registry.close-session' }), Math.max(0, session.expiresAt - Date.now()))
    session.timer.unref()
    const replaced = this.sessions.get(handle)
    if (replaced) this.drop(handle, replaced)
    this.sessions.set(handle, session)
    return session
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
    clearTimeout(session.retry)
    const pending = (async () => this.hangup(session.provider, session.providerSessionId))().then(async () => {
      await this.forget(handle, session)
      return true
    }, async () => {
      if (final || Date.now() >= session.expiresAt) {
        await this.forget(handle, session)
        console.warn('Live session cleanup failed at expiry')
      } else {
        const delay = RETRY_DELAYS_MS[session.attempts++]
        if (delay !== undefined) {
          session.retry = setTimeout(() => { background(this.attempt(handle, session), { name: 'live-session-registry.close-session' }) }, delay)
          session.retry.unref()
        }
        // After bounded retries, the deadline timer makes a final attempt.
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
    clearTimeout(session.timer)
    clearTimeout(session.retry)
    if (session.recorded && !await this.removeEntry(handle, session, 0)) return
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
    session.retry = setTimeout(() => background(async () => {
      // Past the deadline, the entry no longer counts.
      if (Date.now() >= session.expiresAt || await this.removeEntry(handle, session, failures + 1)) this.drop(handle, session)
    }, { name: 'live-session-registry.remove-entry' }), delay)
    session.retry.unref()
    return false
  }

  private drop(handle: string, session: LocalSession): void {
    clearTimeout(session.timer)
    clearTimeout(session.retry)
    if (this.sessions.get(handle) === session) this.sessions.delete(handle)
  }
}
