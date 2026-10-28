/**
 * When one agent's container was last busy, kept in memory by the events
 * that define busyness: the container start, a keep-alive ping from an open
 * dashboard, and a session doing something (a message sent to it, a frame
 * from it, a transcript write). Auto-sleep reads the latest of them.
 *
 * The clock only moves forward: a mark that turns out to be provisional (a
 * send that never reached the container) is left in place, which at worst
 * keeps the container awake for one more timeout window. Every mark is an
 * epoch time in ms, so a frame whose timestamp lies in the past never moves
 * the clock back.
 */
export class ActivityClock {
  private startedAt: number | undefined
  private keepAliveAt: number | undefined
  private sessionActivityAt: number | undefined

  /** The container (re)started; earlier marks are stale. */
  started(at: number = Date.now()): void {
    this.startedAt = at
  }

  /** Whether a start has been recorded since the last reset. */
  hasStarted(): boolean {
    return this.startedAt !== undefined
  }

  /** Something outside a session wants the container kept awake (an open dashboard). */
  keepAlive(at: number = Date.now()): void {
    this.keepAliveAt = at
  }

  /** A session of this agent was written to or sent to at `at`. */
  sessionActivity(at: number = Date.now()): void {
    if (!Number.isFinite(at)) return
    this.sessionActivityAt = Math.max(this.sessionActivityAt ?? -Infinity, at)
  }

  /**
   * The latest mark, or undefined when nothing has marked the clock since the
   * last reset. Undefined is "unknown", not "idle since forever": a caller
   * deciding whether to reap treats it as not yet idle.
   */
  lastActivityAt(): number | undefined {
    const marks = [this.startedAt, this.keepAliveAt, this.sessionActivityAt].filter(
      (mark): mark is number => mark !== undefined,
    )
    return marks.length === 0 ? undefined : Math.max(...marks)
  }

  /** Forget every mark: the container stopped or the runtime was dropped. */
  reset(): void {
    this.startedAt = undefined
    this.keepAliveAt = undefined
    this.sessionActivityAt = undefined
  }
}
