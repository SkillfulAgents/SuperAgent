/**
 * The alarm that puts an idle container to sleep.
 *
 * Every mark on the container's activity clock (its start, a keep-alive, a
 * session write) re-arms one timer for the auto-sleep timeout counted from
 * that mark. When it fires, the container is either busy (a session active
 * or awaiting input), in which case the alarm waits another full window; or
 * quiet but marked more recently than the timeout, in which case it waits the
 * remainder; or idle past the timeout, in which case it sleeps.
 *
 * This is the local form of what a remote actor does with its own alarm: the
 * activity and the decision are known where the container is, and nothing
 * central has to poll. The timeout is read at every arm, so a settings change
 * takes effect when the host re-arms the running alarms, and zero disables.
 *
 * A sleep that does not complete (stop and kill timed out with force-stop
 * disabled, which is the only escalation this alarm never takes) leaves the
 * clock marked; the alarm then retries a minute later, as the old sweep did.
 */

export interface IdleAlarmDeps {
  /** How long the container may be idle before it sleeps, in ms; zero or less disables. Read at every arm. */
  timeoutMs(): number
  /**
   * The clock: when the container was last busy, or undefined when there is
   * nothing to sleep — no mark since it stopped, or a container that is not
   * running. Undefined never arms and never retries.
   */
  lastActivityAt(): number | undefined
  /** Whether the container is busy right now: a session active or awaiting input. */
  isBusy(): boolean
  /** Put the container to sleep. A completed stop resets the clock; one that does not leaves it marked. */
  sleep(): Promise<void>
  /** The clock to read time from; `Date.now` unless a test says otherwise. */
  now?(): number
}

/** How long a sleep that did not complete waits before the alarm tries again. */
export const IDLE_ALARM_RETRY_MS = 60_000

/**
 * The longest delay Node's `setTimeout` honours (2^31 - 1 ms, about 24.8
 * days); anything longer is silently run after 1 ms with an overflow warning.
 * A longer wait is armed in legs of this length, and every fire rechecks the
 * deadline before doing anything.
 */
export const MAX_TIMER_MS = 2_147_483_647

/**
 * Whether a container whose idle clock reads `idleSince` (see
 * `ContainerOps.idleSince`) has been idle for longer than `timeoutMs` at
 * `now`. A `null` clock — busy, or nothing recorded yet — is never idle.
 */
export function idleLongerThan(idleSince: number | null, timeoutMs: number, now: number): boolean {
  return idleSince !== null && now - idleSince > timeoutMs
}

export class IdleAlarm {
  private timer: NodeJS.Timeout | null = null
  private firing = false

  constructor(private readonly deps: IdleAlarmDeps) {}

  /**
   * Arm for the timeout counted from the last mark: called on every mark, and
   * by the host when the timeout setting changes. Disabled, or nothing on the
   * clock, means no alarm. A mark already older than the timeout fires at once.
   */
  schedule(): void {
    this.cancel()
    const timeoutMs = this.deps.timeoutMs()
    if (timeoutMs <= 0) return
    const last = this.deps.lastActivityAt()
    if (last === undefined) return
    this.armIn(Math.max(0, last + timeoutMs - this.now()))
  }

  /** Disarm: the container stopped, or the runtime was dropped. */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  isArmed(): boolean {
    return this.timer !== null
  }

  /**
   * Decide now: sleep if idle past the timeout, otherwise re-arm. What the
   * timer runs, and public so a caller can run it without waiting for one.
   */
  async fire(): Promise<void> {
    if (this.firing) return
    this.firing = true
    try {
      this.cancel()
      const timeoutMs = this.deps.timeoutMs()
      if (timeoutMs <= 0) return
      const last = this.deps.lastActivityAt()
      if (last === undefined) return
      const idleSince = this.deps.isBusy() ? null : last
      if (!idleLongerThan(idleSince, timeoutMs, this.now())) {
        // Busy: a full window from now. Quiet but recent: the remainder.
        this.armIn(idleSince === null ? timeoutMs : last + timeoutMs - this.now())
        return
      }
      try {
        await this.deps.sleep()
      } catch (error) {
        console.error('[IdleAlarm] Sleep failed; will retry:', error)
      }
      // A completed stop reset the clock. Anything still on it means the
      // container is up (the stop did not complete, or a mark landed during
      // it and the mark's own re-arm was lost to the reset): try again soon.
      if (this.deps.lastActivityAt() !== undefined && !this.timer) this.armIn(IDLE_ALARM_RETRY_MS)
    } finally {
      this.firing = false
    }
  }

  private armIn(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      void this.fire()
    }, Math.min(ms, MAX_TIMER_MS))
    // An armed alarm is not a reason to keep the process alive.
    this.timer.unref?.()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
