/**
 * Named locks over one agent, for host work that must not run twice at once
 * for it: one x-agent invoke per target session, one delivery per scheduled
 * wake, one widget repair being opened, one identity change at a time.
 *
 * A key is the caller's own, prefixed with what it guards (`wake:<taskId>`).
 * A lock is held by a token; releasing with a token that no longer holds it
 * (released already, or dropped with the agent) does nothing, so a holder
 * that outlives the agent's state cannot let go of a lock someone else took
 * since.
 */
import { randomUUID } from 'crypto'

interface Lock {
  token: string
  /** Who asked while it was held, in order: each is handed the lock in turn. */
  waiters: Array<{ grant: (token: string) => void; turnAway: (error: Error) => void }>
}

export class AgentLocks {
  private locks = new Map<string, Lock>()

  /** Take `key` unless it is held: the token that releases it, or null. */
  tryAcquire(key: string): string | null {
    if (this.locks.has(key)) return null
    const token = randomUUID()
    this.locks.set(key, { token, waiters: [] })
    return token
  }

  /** Take `key` once every earlier holder and waiter has let it go. */
  acquire(key: string): Promise<string> {
    const lock = this.locks.get(key)
    if (!lock) return Promise.resolve(this.tryAcquire(key)!)
    return new Promise((grant, turnAway) => lock.waiters.push({ grant, turnAway }))
  }

  /** Let go of `key`, handing it to the next waiter if there is one. */
  release(key: string, token: string): void {
    const lock = this.locks.get(key)
    if (lock?.token !== token) return
    const next = lock.waiters.shift()
    if (!next) {
      this.locks.delete(key)
      return
    }
    lock.token = randomUUID()
    next.grant(lock.token)
  }

  /** The agent is gone: every waiter is turned away, and every lock let go. */
  dispose(): void {
    const gone = new Error('Lock dropped: the agent is no longer held by this process')
    for (const lock of this.locks.values()) {
      for (const waiter of lock.waiters) waiter.turnAway(gone)
    }
    this.locks.clear()
  }
}
