import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE_ALARM_RETRY_MS, IdleAlarm, MAX_TIMER_MS, idleLongerThan, setIdleAlarmTimers } from './idle-alarm'

const MINUTE = 60_000
const TIMEOUT = 30 * MINUTE
const T0 = new Date('2026-03-01T12:00:00Z').getTime()

/** An alarm over a fake container: a clock, a busy flag and a stop that resets the clock. */
function fakeContainer(options: { timeoutMs?: number; stopCompletes?: boolean } = {}) {
  const state = {
    lastActivityAt: undefined as number | undefined,
    busy: false,
    timeoutMs: options.timeoutMs ?? TIMEOUT,
    stopCompletes: options.stopCompletes ?? true,
  }
  const sleep = vi.fn(async (_timeoutMs: number) => {
    if (state.stopCompletes) state.lastActivityAt = undefined
  })
  // The timeout is a settings read: asynchronous, and read fresh every time.
  const timeoutMs = vi.fn(async () => state.timeoutMs)
  const alarm = new IdleAlarm({
    agentSlug: () => 'support-agent',
    timeoutMs,
    lastActivityAt: () => state.lastActivityAt,
    isBusy: () => state.busy,
    sleep,
  })
  const mark = (at = Date.now()) => {
    state.lastActivityAt = Math.max(state.lastActivityAt ?? -Infinity, at)
    alarm.schedule()
  }
  return { state, sleep, timeoutMs, alarm, mark }
}

/** Let the timeout reads in flight land, without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('idleLongerThan', () => {
  it('is a pure function of the clock and the timeout', () => {
    expect(idleLongerThan(T0 - TIMEOUT - 1, TIMEOUT, T0)).toBe(true)
    expect(idleLongerThan(T0 - TIMEOUT, TIMEOUT, T0)).toBe(false)
    expect(idleLongerThan(T0 - 5 * MINUTE, TIMEOUT, T0)).toBe(false)
  })

  it('never calls a null clock idle: busy, or nothing recorded yet', () => {
    expect(idleLongerThan(null, TIMEOUT, T0)).toBe(false)
    expect(idleLongerThan(null, 0, T0)).toBe(false)
  })
})

describe('IdleAlarm', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sleeps the container one timeout after its last mark', async () => {
    const { sleep, alarm, mark } = fakeContainer()
    mark()
    await settle()
    expect(alarm.isArmed()).toBe(true)

    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(sleep).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(TIMEOUT)
    expect(alarm.isArmed()).toBe(false)
  })

  it('every mark pushes the alarm out: a keep-alive or a session write inside the window keeps it awake', async () => {
    const { sleep, mark } = fakeContainer()
    mark()
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    mark()
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    expect(sleep).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10 * MINUTE + 1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('a mark stamped in the past arms for the remainder, and one past the timeout fires at once', async () => {
    const { sleep, mark } = fakeContainer()
    mark(T0 - 25 * MINUTE)
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(sleep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sleep).toHaveBeenCalledTimes(1)

    const stale = fakeContainer()
    stale.mark(T0 - TIMEOUT - MINUTE)
    await vi.advanceTimersByTimeAsync(0)
    expect(stale.sleep).toHaveBeenCalledTimes(1)
  })

  it('waits another full window while the container is busy at fire time', async () => {
    const { state, sleep, alarm, mark } = fakeContainer()
    mark()
    state.busy = true
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(sleep).not.toHaveBeenCalled()
    expect(alarm.isArmed()).toBe(true)

    // The turn ends without a new mark (nothing wrote): the next fire sleeps.
    state.busy = false
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('never arms while disabled, and disarms when disabled before it fires', async () => {
    const off = fakeContainer({ timeoutMs: 0 })
    off.mark()
    await settle()
    expect(off.alarm.isArmed()).toBe(false)

    const { state, sleep, alarm, mark } = fakeContainer()
    mark()
    await settle()
    expect(alarm.isArmed()).toBe(true)
    state.timeoutMs = 0
    alarm.schedule()
    await settle()
    expect(alarm.isArmed()).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('never arms with nothing on the clock', async () => {
    const { alarm } = fakeContainer()
    alarm.schedule()
    await settle()
    expect(alarm.isArmed()).toBe(false)
  })

  it('a shorter timeout applies on re-schedule, firing at once when the mark is already past it', async () => {
    const { state, sleep, alarm, mark } = fakeContainer()
    mark()
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    state.timeoutMs = 5 * MINUTE
    alarm.schedule()
    await vi.advanceTimersByTimeAsync(0)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('retries a minute later when the stop did not complete', async () => {
    const { state, sleep, alarm, mark } = fakeContainer({ stopCompletes: false })
    mark()
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(alarm.isArmed()).toBe(true)

    await vi.advanceTimersByTimeAsync(IDLE_ALARM_RETRY_MS)
    expect(sleep).toHaveBeenCalledTimes(2)

    // Once the stop lands the clock resets and the retries end.
    state.stopCompletes = true
    await vi.advanceTimersByTimeAsync(IDLE_ALARM_RETRY_MS)
    expect(sleep).toHaveBeenCalledTimes(3)
    expect(alarm.isArmed()).toBe(false)
  })

  it('retries after a stop that threw, and logs it', async () => {
    const { sleep, alarm, mark } = fakeContainer()
    sleep.mockRejectedValueOnce(new Error('runtime busy'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mark()
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(alarm.isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(IDLE_ALARM_RETRY_MS)
    expect(sleep).toHaveBeenCalledTimes(2)
    consoleError.mockRestore()
  })

  it('cancel disarms, and a later mark arms again', async () => {
    const { sleep, alarm, mark } = fakeContainer()
    mark()
    await settle()
    expect(alarm.isArmed()).toBe(true)
    alarm.cancel()
    expect(alarm.isArmed()).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT)
    expect(sleep).not.toHaveBeenCalled()

    mark()
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('waits out a timeout longer than a Node timer in legs, without firing early', async () => {
    const THIRTY_DAYS = 30 * 24 * 60 * MINUTE
    const { sleep, alarm, mark } = fakeContainer({ timeoutMs: THIRTY_DAYS })
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    mark()
    await settle()
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), MAX_TIMER_MS)

    // The first leg ends before the deadline: the alarm rechecks and re-arms.
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS)
    expect(sleep).not.toHaveBeenCalled()
    expect(alarm.isArmed()).toBe(true)
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(THIRTY_DAYS - MAX_TIMER_MS + 1)
    expect(sleep).toHaveBeenCalledTimes(1)
    setTimeoutSpy.mockRestore()
  })

  it('fire() decides now and ignores a second call while a sleep is in flight', async () => {
    const { state, sleep, alarm, mark } = fakeContainer()
    let release!: () => void
    sleep.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    mark(T0 - TIMEOUT - 1)
    const first = alarm.fire()
    await alarm.fire()
    await settle()
    expect(sleep).toHaveBeenCalledTimes(1)
    state.lastActivityAt = undefined
    release()
    await first
    expect(alarm.isArmed()).toBe(false)
  })

  it('reads the timeout again at fire: a change made after the alarm was armed decides', async () => {
    const longer = fakeContainer()
    longer.mark()
    await settle()
    expect(longer.timeoutMs).toHaveBeenCalledTimes(1)
    // Changed elsewhere, with nothing here re-arming: the alarm fires on the
    // old deadline, reads the new timeout, and waits out the remainder.
    longer.state.timeoutMs = 2 * TIMEOUT
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(longer.timeoutMs).toHaveBeenCalledTimes(2)
    expect(longer.sleep).not.toHaveBeenCalled()
    expect(longer.alarm.isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(longer.sleep).toHaveBeenCalledTimes(1)
    expect(longer.sleep).toHaveBeenCalledWith(2 * TIMEOUT)

    const disabled = fakeContainer()
    disabled.mark()
    await settle()
    disabled.state.timeoutMs = 0
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(disabled.sleep).not.toHaveBeenCalled()
    expect(disabled.alarm.isArmed()).toBe(false)
  })

  it('a burst of marks shares one timeout read, which arms from the latest mark when it lands', async () => {
    const { sleep, timeoutMs, alarm, mark } = fakeContainer()
    let landRead!: (ms: number) => void
    timeoutMs.mockImplementationOnce(() => new Promise<number>((resolve) => { landRead = resolve }))
    mark()
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    // Session writes while the read is out: none starts another read.
    for (let i = 0; i < 5; i++) mark()
    expect(timeoutMs).toHaveBeenCalledTimes(1)

    landRead(TIMEOUT)
    await settle()
    expect(alarm.isArmed()).toBe(true)
    // Counted from the latest mark (at +5m), not the first.
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(sleep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sleep).toHaveBeenCalledTimes(1)

    // Once it landed, the next mark reads again.
    timeoutMs.mockClear()
    mark()
    expect(timeoutMs).toHaveBeenCalledTimes(1)
  })

  it('a re-arm with a timeout read after a change wins over a read started before it', async () => {
    const { state, sleep, timeoutMs, alarm, mark } = fakeContainer()
    let landSlowRead!: (ms: number) => void
    timeoutMs.mockImplementationOnce(() => new Promise<number>((resolve) => { landSlowRead = resolve }))
    mark()
    // The setting changes to 5 minutes; the host re-arms with what it read after the change.
    state.timeoutMs = 5 * MINUTE
    alarm.rearm(5 * MINUTE)
    expect(alarm.isArmed()).toBe(true)

    // The read from before the change lands late with the old timeout: it arms nothing.
    landSlowRead(TIMEOUT)
    await settle()
    // A mark after the re-arm reads afresh instead of joining the detached read.
    timeoutMs.mockClear()
    mark()
    expect(timeoutMs).toHaveBeenCalledTimes(1)
    await settle()
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 1)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(5 * MINUTE)
  })

  it('a re-arm to zero disarms, and ensureArmed arms only what is not armed', async () => {
    const { timeoutMs, alarm, mark } = fakeContainer()
    mark()
    await settle()
    expect(alarm.isArmed()).toBe(true)
    alarm.rearm(0)
    expect(alarm.isArmed()).toBe(false)

    // Nothing armed: a sweep's timeout arms it without a read.
    timeoutMs.mockClear()
    alarm.ensureArmed(TIMEOUT)
    expect(alarm.isArmed()).toBe(true)
    expect(timeoutMs).not.toHaveBeenCalled()

    // Armed: nothing to do, and nothing read.
    alarm.ensureArmed()
    alarm.ensureArmed(TIMEOUT)
    await settle()
    expect(timeoutMs).not.toHaveBeenCalled()

    // Nothing armed and no timeout given: it reads for itself.
    alarm.cancel()
    alarm.ensureArmed()
    await settle()
    expect(timeoutMs).toHaveBeenCalledTimes(1)
    expect(alarm.isArmed()).toBe(true)
  })

  it('a mark made while a fire reads the timeout decides instead of the fire', async () => {
    const { state, sleep, timeoutMs, alarm, mark } = fakeContainer()
    // Idle past the timeout as the fire begins.
    state.lastActivityAt = T0 - TIMEOUT - 1
    let landFireRead!: (ms: number) => void
    timeoutMs.mockImplementationOnce(() => new Promise<number>((resolve) => { landFireRead = resolve }))
    const firing = alarm.fire()
    // Activity lands while the fire is still reading: the container is not idle.
    mark()
    await settle()
    landFireRead(TIMEOUT)
    await firing
    expect(sleep).not.toHaveBeenCalled()
    expect(alarm.isArmed()).toBe(true)

    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('a stop while a timeout read is in flight is not undone by the read', async () => {
    const { timeoutMs, alarm, mark } = fakeContainer()
    let landRead!: (ms: number) => void
    timeoutMs.mockImplementationOnce(() => new Promise<number>((resolve) => { landRead = resolve }))
    mark()
    alarm.cancel()
    landRead(TIMEOUT)
    await settle()
    expect(alarm.isArmed()).toBe(false)
  })

  it('a timeout read that fails keeps the alarm armed, or retries a minute later when nothing was', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { sleep, timeoutMs, alarm, mark } = fakeContainer()
    timeoutMs.mockRejectedValueOnce(new Error('database is locked'))
    mark()
    await settle()
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(alarm.isArmed()).toBe(true)

    // The retry reads again and arms for the rest of the window.
    await vi.advanceTimersByTimeAsync(IDLE_ALARM_RETRY_MS)
    expect(sleep).not.toHaveBeenCalled()
    expect(alarm.isArmed()).toBe(true)

    // A later schedule whose read fails leaves that alarm in place.
    timeoutMs.mockRejectedValueOnce(new Error('database is locked'))
    alarm.schedule()
    await settle()
    expect(consoleError).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(TIMEOUT - IDLE_ALARM_RETRY_MS + 1)
    expect(sleep).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })
})

describe('IdleAlarm with a host timer', () => {
  afterEach(() => {
    setIdleAlarmTimers(null)
  })

  it('arms the host timer for the agent, and sleeps when the host rings it', async () => {
    const sets: Array<{ slug: string; at: number }> = []
    let ring: (() => Promise<void>) | undefined
    setIdleAlarmTimers((slug, ringAlarm) => {
      ring = ringAlarm
      return { set: (at) => sets.push({ slug, at }), clear: () => {} }
    })
    let lastActivityAt: number | undefined = Date.now() - TIMEOUT - 1
    // A completed stop resets the clock.
    const sleep = vi.fn(async () => {
      lastActivityAt = undefined
    })
    const alarm = new IdleAlarm({ agentSlug: () => 'sales-agent', timeoutMs: async () => TIMEOUT, lastActivityAt: () => lastActivityAt, isBusy: () => false, sleep })

    alarm.rearm(TIMEOUT)
    expect(sets).toEqual([{ slug: 'sales-agent', at: expect.any(Number) }])
    expect(alarm.isArmed()).toBe(true)

    await ring!()
    expect(sleep).toHaveBeenCalledWith(TIMEOUT)
    expect(alarm.isArmed()).toBe(false)
  })
})
