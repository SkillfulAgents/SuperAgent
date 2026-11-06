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
 * central has to poll. The timeout is a setting, read fresh for every arm and
 * again at every fire, so a change made anywhere applies no later than the
 * next fire, a change made here applies when the host re-arms the running
 * alarms (with one read for all of them), and zero disables.
 *
 * Reading the timeout is asynchronous. The marks themselves are recorded by
 * the caller before it schedules, synchronously and in order. The arm that
 * follows reads the timeout, then the clock, so it counts from every mark
 * made up to the moment it lands; a burst of marks while that read is out
 * shares it rather than reading once per mark. A fire, a cancel or a re-arm
 * with a timeout read after a settings change detaches the read in flight, so
 * a read started before them never re-arms over what they decided.
 *
 * A sleep that does not complete (stop and kill timed out with force-stop
 * disabled, which is the only escalation this alarm never takes) leaves the
 * clock marked; the alarm then retries a minute later, as the old sweep did.
 * So does a timeout read that failed with nothing armed.
 *
 * The alarm waits on a process timer by default. A host that keeps an alarm
 * of its own for each agent, one that outlives the process, supplies the
 * timer through `setIdleAlarmTimers` and rings it when that alarm goes off.
 */
import { background } from '../background'

export interface IdleAlarmDeps {
  /** The agent this alarm belongs to: what a host timer keys its alarm by. */
  agentSlug?(): string
  /**
   * How long the container may be idle before it sleeps, in ms; zero or less
   * disables. Read for every arm (one read shared by the marks made while it
   * is out) and at every fire, never kept between them.
   */
  timeoutMs(): Promise<number>
  /**
   * The clock: when the container was last busy, or undefined when there is
   * nothing to sleep — no mark since it stopped, or a container that is not
   * running. Undefined never arms and never retries.
   */
  lastActivityAt(): number | undefined
  /** Whether the container is busy right now: a session active or awaiting input. */
  isBusy(): boolean
  /**
   * Put the container to sleep, idle past `timeoutMs` (the timeout this
   * decision read). A completed stop resets the clock; one that does not
   * leaves it marked.
   */
  sleep(timeoutMs: number): Promise<void>
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

/** Where one agent's alarm waits. */
export interface IdleAlarmTimer {
  /** Ring at `at` (epoch ms), `inMs` from now, replacing any earlier time. */
  set(at: number, inMs: number): void
  clear(): void
}

/** Makes the timer for one agent's alarm. `ring` runs the alarm's decision and settles once it is made. */
export type IdleAlarmTimerFactory = (agentSlug: string, ring: () => Promise<void>) => IdleAlarmTimer

function processTimer(_agentSlug: string, ring: () => Promise<void>): IdleAlarmTimer {
  let handle: NodeJS.Timeout | null = null
  const clear = () => {
    if (handle) clearTimeout(handle)
    handle = null
  }
  return {
    set(_at, inMs) {
      clear()
      handle = setTimeout(() => {
        handle = null
        background(ring(), { name: 'idle-alarm.sleep-if-idle' })
      }, Math.min(inMs, MAX_TIMER_MS))
      // An armed alarm is not a reason to keep the process alive.
      handle.unref?.()
    },
    clear,
  }
}

let timerFactory: IdleAlarmTimerFactory = processTimer

/**
 * Replaces the process timer for every alarm first armed from now on: an alarm
 * keeps the timer it was first armed with, so a host sets this at boot. `null`
 * puts the process timer back.
 */
export function setIdleAlarmTimers(factory: IdleAlarmTimerFactory | null): void {
  timerFactory = factory ?? processTimer
}

export class IdleAlarm {
  private timer: IdleAlarmTimer | null = null
  private armed = false
  private firing = false
  /**
   * Bumped by every schedule, re-arm, fire and cancel. A fire's decision
   * applies only while its number is still the latest: anything begun after
   * its read started (a newer mark's schedule, a re-arm, a stop's cancel)
   * decides instead.
   */
  private generation = 0
  /**
   * The schedules' timeout read in flight, if any. A schedule while it is out
   * joins it instead of starting another read; it arms only if it is still
   * this read when it lands. A fire, a re-arm or a cancel detaches it.
   */
  private pendingRead: object | null = null

  constructor(private readonly deps: IdleAlarmDeps) {}

  /**
   * Arm for the timeout counted from the last mark: called after every mark.
   * Disabled, or nothing on the clock, means no alarm. A mark already older
   * than the timeout fires at once.
   *
   * Returns before the alarm is armed: the timeout is read in the background
   * (tracked by `background()`), and the clock is read after it, so the arm
   * counts from every mark made up to then. A schedule while that read is out
   * starts no other: the one read arms from the latest mark when it lands.
   * Whatever was armed before stays armed until the read lands, so a read
   * that fails loses no alarm.
   */
  schedule(): void {
    // A fire still reading no longer decides: this mark is newer.
    this.generation++
    if (this.pendingRead) return
    const read = {}
    this.pendingRead = read
    background(this.arm(read), { name: 'idle-alarm.arm' })
  }

  /**
   * Arm now from a timeout the caller read: the host re-arming every alarm
   * after the timeout setting changed, with one read made after the change
   * (or the value the change committed). A schedule's read in flight, which
   * may have started before the change, is detached and arms nothing.
   */
  rearm(timeoutMs: number): void {
    this.generation++
    this.pendingRead = null
    this.armFrom(timeoutMs)
  }

  /**
   * Arm unless an alarm is armed already or a schedule's read is on its way:
   * a status sync that finds the container running. An armed alarm is right
   * as it is (every mark re-armed it, and its fire reads the timeout again),
   * so a periodic sync costs nothing. `timeoutMs`, read once by the caller for
   * a sweep over many containers, arms without a read of its own; the fire
   * still reads afresh before it puts anything to sleep.
   */
  ensureArmed(timeoutMs?: number): void {
    if (this.armed || this.pendingRead) return
    if (timeoutMs === undefined) this.schedule()
    else this.rearm(timeoutMs)
  }

  /** Disarm: the container stopped, or the runtime was dropped. A read in flight no longer arms. */
  cancel(): void {
    this.generation++
    this.pendingRead = null
    this.clearTimer()
  }

  isArmed(): boolean {
    return this.armed
  }

  /**
   * Decide now: sleep if idle past the timeout, otherwise re-arm. What the
   * timer runs, and public so a caller can run it without waiting for one.
   * The timeout is read again here, and the clock and the busy state after
   * it, so the decision is never made on a timeout older than this fire.
   */
  async fire(): Promise<void> {
    if (this.firing) return
    this.firing = true
    try {
      this.clearTimer()
      const generation = ++this.generation
      // This fire reads for itself; a schedule's read started before it no longer arms.
      this.pendingRead = null
      const timeoutMs = await this.readTimeout(() => generation === this.generation)
      // A mark, a re-arm or a stop since this fire began decides instead.
      if (timeoutMs === null || generation !== this.generation) return
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
        await this.deps.sleep(timeoutMs)
      } catch (error) {
        console.error('[IdleAlarm] Sleep failed; will retry:', error)
      }
      // A completed stop reset the clock. Anything still on it means the
      // container is up (the stop did not complete, or a mark landed during
      // it and the mark's own re-arm was lost to the reset): try again soon.
      if (this.deps.lastActivityAt() !== undefined && !this.armed) this.armIn(IDLE_ALARM_RETRY_MS)
    } finally {
      this.firing = false
    }
  }

  /**
   * What `schedule` starts: read the timeout, then arm from the clock, unless
   * a fire, a re-arm or a cancel detached this read meanwhile.
   */
  private async arm(read: object): Promise<void> {
    const current = () => this.pendingRead === read
    const timeoutMs = await this.readTimeout(current)
    if (!current()) return
    this.pendingRead = null
    if (timeoutMs === null) return
    this.armFrom(timeoutMs)
  }

  /** Arm for `timeoutMs` counted from the clock as it stands now. */
  private armFrom(timeoutMs: number): void {
    this.clearTimer()
    if (timeoutMs <= 0) return
    const last = this.deps.lastActivityAt()
    if (last === undefined) return
    this.armIn(Math.max(0, last + timeoutMs - this.now()))
  }

  /**
   * The timeout, or null when the read failed. A failed read leaves whatever
   * is armed in place; with nothing armed for a container still on the clock,
   * and nothing newer deciding (`current`), it retries a minute later rather
   * than leave the container awake for good.
   */
  private async readTimeout(current: () => boolean): Promise<number | null> {
    try {
      return await this.deps.timeoutMs()
    } catch (error) {
      console.error('[IdleAlarm] Could not read the auto-sleep timeout; will retry:', error)
      if (current() && !this.armed && this.deps.lastActivityAt() !== undefined) {
        this.armIn(IDLE_ALARM_RETRY_MS)
      }
      return null
    }
  }

  private clearTimer(): void {
    if (!this.armed) return
    this.armed = false
    this.timer?.clear()
  }

  private armIn(ms: number): void {
    this.timer ??= timerFactory(this.deps.agentSlug?.() ?? '', () => {
      this.armed = false
      return this.fire()
    })
    this.armed = true
    this.timer.set(this.now() + ms, ms)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
