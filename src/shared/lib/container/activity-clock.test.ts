import { describe, expect, it } from 'vitest'
import { ActivityClock } from './activity-clock'

describe('ActivityClock', () => {
  it('knows nothing until something marks it', () => {
    const clock = new ActivityClock()
    expect(clock.lastActivityAt()).toBeUndefined()
    expect(clock.hasStarted()).toBe(false)
  })

  it('answers the latest of start, keep-alive and session activity', () => {
    const clock = new ActivityClock()
    clock.started(1_000)
    expect(clock.hasStarted()).toBe(true)
    expect(clock.lastActivityAt()).toBe(1_000)

    clock.sessionActivity(5_000)
    expect(clock.lastActivityAt()).toBe(5_000)

    clock.keepAlive(9_000)
    expect(clock.lastActivityAt()).toBe(9_000)
  })

  it('never moves session activity backwards', () => {
    const clock = new ActivityClock()
    clock.sessionActivity(5_000)
    // A frame stamped in the past (a replayed write, a transcript mtime) or
    // a bogus timestamp leaves the clock where it was.
    clock.sessionActivity(2_000)
    clock.sessionActivity(Number.NaN)
    expect(clock.lastActivityAt()).toBe(5_000)
  })

  it('floors a fresh start below older session activity without losing it', () => {
    // A container discovered running again after a host restart is floored
    // at rediscovery; session marks from before the restart are gone with
    // the process, so the start is what counts.
    const clock = new ActivityClock()
    clock.sessionActivity(8_000)
    clock.started(3_000)
    expect(clock.lastActivityAt()).toBe(8_000)
  })

  it('forgets everything on reset', () => {
    const clock = new ActivityClock()
    clock.started(1_000)
    clock.keepAlive(2_000)
    clock.sessionActivity(3_000)
    clock.reset()
    expect(clock.lastActivityAt()).toBeUndefined()
    expect(clock.hasStarted()).toBe(false)
  })

  it('defaults every mark to now', () => {
    const clock = new ActivityClock()
    const before = Date.now()
    clock.keepAlive()
    expect(clock.lastActivityAt()).toBeGreaterThanOrEqual(before)
  })
})
