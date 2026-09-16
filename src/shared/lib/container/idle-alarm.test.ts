import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE_ALARM_RETRY_MS, IdleAlarm, MAX_TIMER_MS, idleLongerThan } from './idle-alarm'

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
  const sleep = vi.fn(async () => {
    if (state.stopCompletes) state.lastActivityAt = undefined
  })
  const alarm = new IdleAlarm({
    timeoutMs: () => state.timeoutMs,
    lastActivityAt: () => state.lastActivityAt,
    isBusy: () => state.busy,
    sleep,
  })
  const mark = (at = Date.now()) => {
    state.lastActivityAt = Math.max(state.lastActivityAt ?? -Infinity, at)
    alarm.schedule()
  }
  return { state, sleep, alarm, mark }
}

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
    expect(alarm.isArmed()).toBe(true)

    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(sleep).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(sleep).toHaveBeenCalledTimes(1)
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
    expect(off.alarm.isArmed()).toBe(false)

    const { state, sleep, alarm, mark } = fakeContainer()
    mark()
    state.timeoutMs = 0
    alarm.schedule()
    expect(alarm.isArmed()).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('never arms with nothing on the clock', () => {
    const { alarm } = fakeContainer()
    alarm.schedule()
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
    expect(sleep).toHaveBeenCalledTimes(1)
    state.lastActivityAt = undefined
    release()
    await first
    expect(alarm.isArmed()).toBe(false)
  })
})
