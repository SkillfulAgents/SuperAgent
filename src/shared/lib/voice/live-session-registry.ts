import { randomUUID } from 'node:crypto'

export const LIVE_SESSION_MAX_MS = 60 * 60 * 1000
const RETRY_DELAYS_MS = [1000, 5000, 30_000]
interface Session {
  owner: string
  id: string
  expiresAt: number
  closing: boolean
  attempts: number
  timer: ReturnType<typeof setTimeout>
  retry?: ReturnType<typeof setTimeout>
  pending?: Promise<boolean>
}

/** Closing calls stop consuming admission slots, but retain cleanup until expiry. */
export class LiveSessionRegistry {
  private sessions = new Map<string, Session>()
  constructor(private hangup: (id: string) => Promise<void>) {}

  activeCount(owner: string) {
    return [...this.sessions.values()].filter(session => session.owner === owner && !session.closing).length
  }

  add(owner: string, id: string) {
    const handle = randomUUID()
    const expiresAt = Date.now() + LIVE_SESSION_MAX_MS
    const timer = setTimeout(() => {
      const session = this.sessions.get(handle)
      if (!session) return
      session.closing = true
      void this.attempt(handle, session, true)
    }, LIVE_SESSION_MAX_MS)
    timer.unref()
    this.sessions.set(handle, { owner, id, expiresAt, timer, closing: false, attempts: 0 })
    return { handle, expiresAt }
  }

  async release(handle: string, owner: string): Promise<'missing' | 'closed' | 'closing'> {
    const session = this.sessions.get(handle)
    if (!session || session.owner !== owner) return 'missing'
    session.closing = true
    return await this.attempt(handle, session) ? 'closed' : 'closing'
  }

  private attempt(handle: string, session: Session, final = false): Promise<boolean> {
    if (session.pending) return session.pending
    clearTimeout(session.retry)
    const pending = this.hangup(session.id).then(() => {
      this.remove(handle, session)
      return true
    }, () => {
      if (final || Date.now() >= session.expiresAt) {
        this.remove(handle, session)
        console.warn('Live session cleanup failed at expiry')
      } else {
        const delay = RETRY_DELAYS_MS[session.attempts++]
        if (delay !== undefined) {
          session.retry = setTimeout(() => { void this.attempt(handle, session) }, delay)
          session.retry.unref()
        }
        // After bounded retries, the original expiry timer makes a final attempt.
      }
      return false
    }).finally(() => { session.pending = undefined })
    session.pending = pending
    return pending
  }

  private remove(handle: string, session: Session) {
    clearTimeout(session.timer)
    clearTimeout(session.retry)
    this.sessions.delete(handle)
  }
}
