// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AMBIENT_SLOW_MS,
  ambientAnimationAllowed,
  subscribeToAmbientAnimationAllowed,
  subscribeToAmbientFrames,
  wakeAmbientFrames,
} from './ambient-frames'

describe('ambient frames', () => {
  let callbacks: FrameRequestCallback[]
  let hasFocus: ReturnType<typeof vi.spyOn>
  let hidden: boolean
  const stops: Array<() => void> = []
  const subscribe = (...args: Parameters<typeof subscribeToAmbientFrames>) => {
    const stop = subscribeToAmbientFrames(...args)
    stops.push(stop)
    return stop
  }
  /** Run the display frame at `now`, if the loop asked for one. */
  const display = (now: number) => {
    const pending = callbacks
    callbacks = []
    pending.forEach((callback) => callback(now))
  }
  /** A display at `hz` from `from`, for `ms`: every frame it shows in that time. */
  const displayFor = (from: number, ms: number, hz = 120) => {
    for (let i = 0; i * (1000 / hz) < ms; i++) display(from + i * (1000 / hz))
  }
  const background = () => {
    hasFocus.mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
  }
  const foreground = () => {
    hasFocus.mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    callbacks = []
    hidden = false
    hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => callbacks.push(callback))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      callbacks = []
    })
  })

  afterEach(() => {
    stops.splice(0).forEach((stop) => stop())
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('in the window in use', () => {
    it('paints the first frame, then 60 times a second on a 120 Hz display', () => {
      const tick = vi.fn()
      subscribe(tick, { kind: 'decoration' })
      displayFor(1000, 1000)
      expect(tick.mock.calls[0][0]).toBe(1000)
      expect(tick).toHaveBeenCalledTimes(60)
    })

    it.each([60, 75, 90, 144])('holds 60 a second on a %i Hz display', (hz) => {
      const tick = vi.fn()
      subscribe(tick, { kind: 'decoration' })
      displayFor(1000, 2000, hz)
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(118)
      expect(tick.mock.calls.length).toBeLessThanOrEqual(121)
    })

    it('keeps every frame of a 60 Hz display whose frames arrive a little early or late', () => {
      const tick = vi.fn()
      subscribe(tick, { kind: 'decoration' })
      for (let i = 0; i < 60; i++) display(1000 + i * (1000 / 60) + (i % 2 ? 1 : -1))
      expect(tick).toHaveBeenCalledTimes(60)
    })

    it('paints 30-a-second subscribers on every other beat, together, whenever they joined', () => {
      const fast = vi.fn()
      const slowA = vi.fn()
      const slowB = vi.fn()
      subscribe(fast, { kind: 'decoration' })
      subscribe(slowA, { kind: 'decoration', fps: 30 })
      displayFor(1000, 25) // a beat goes by before the second one joins
      subscribe(slowB, { kind: 'decoration', fps: 30 })
      display(1025) // each is painted once on joining
      slowA.mockClear()
      slowB.mockClear()
      displayFor(1033, 1000)
      // The same beats: a page of slow animations composites 30 times a second, not 60.
      expect(slowA.mock.calls.map(([now]) => now)).toEqual(slowB.mock.calls.map(([now]) => now))
      expect(slowA.mock.calls.length).toBeGreaterThanOrEqual(29)
      expect(slowA.mock.calls.length).toBeLessThanOrEqual(31)
    })

    it('runs at 30 a second when nothing asks for more, and follows a pace that changes', () => {
      let fps: 30 | 60 = 30
      const tick = vi.fn()
      subscribe(tick, { kind: 'status', fps: () => fps })
      displayFor(1000, 1000)
      expect(tick).toHaveBeenCalledTimes(30)
      tick.mockClear()
      fps = 60
      displayFor(2000, 1000)
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(59)
    })

    it('reads all geometry before anything writes', () => {
      const order: string[] = []
      subscribe(() => order.push('tick a'), { kind: 'decoration', measure: () => order.push('measure a') })
      subscribe(() => order.push('tick b'), { kind: 'decoration', measure: () => order.push('measure b') })
      display(1000)
      expect(order).toEqual(['measure a', 'measure b', 'tick a', 'tick b'])
    })
  })

  describe('in a window that is shown but not in use', () => {
    /** Run the loop for `ms` of background time: its timers, and the frames it asks for. */
    const backgroundFor = (from: number, ms: number) => {
      for (let t = 0; t < ms; t += 1000 / 120) {
        vi.advanceTimersByTime(1000 / 120)
        display(from + t)
      }
    }

    it('holds decoration and paints status once a second, asking for no frames in between', () => {
      const decoration = vi.fn()
      const status = vi.fn()
      subscribe(decoration, { kind: 'decoration' })
      subscribe(status, { kind: 'status', fps: 30 })
      display(1000)
      background()
      display(1008)
      decoration.mockClear()
      status.mockClear()
      const requested = vi.mocked(window.requestAnimationFrame).mock.calls.length

      backgroundFor(1016, 3000)
      expect(decoration).not.toHaveBeenCalled()
      expect(status.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(status.mock.calls.length).toBeLessThanOrEqual(4)
      // One frame per slow beat, not 120 a second.
      expect(vi.mocked(window.requestAnimationFrame).mock.calls.length - requested).toBeLessThanOrEqual(5)
    })

    it('asks for no frames at all, and keeps no timer, when only decoration is on the page', () => {
      subscribe(vi.fn(), { kind: 'decoration' })
      subscribe(vi.fn(), { kind: 'decoration', fps: 30 })
      display(1000)
      background()
      display(1008)
      expect(callbacks).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('keeps a live animation at its full rate', () => {
      const live = vi.fn()
      const decoration = vi.fn()
      subscribe(live, { kind: 'live' })
      subscribe(decoration, { kind: 'decoration' })
      display(1000)
      background()
      live.mockClear()
      decoration.mockClear()
      displayFor(1008, 1000)
      expect(live.mock.calls.length).toBeGreaterThanOrEqual(59)
      expect(decoration).not.toHaveBeenCalled()
    })

    it('paints a subscriber that joins at once, so nothing mounts blank', () => {
      background()
      const tick = vi.fn()
      subscribe(tick, { kind: 'decoration' })
      expect(callbacks).toHaveLength(1)
      display(1000)
      expect(tick).toHaveBeenCalledTimes(1)
    })

    it('gives a status animation its full rate for a moment when it is woken, then slows again', () => {
      const tick = vi.fn()
      subscribe(tick, { kind: 'status' })
      display(1000)
      background()
      display(1008)
      tick.mockClear()

      vi.setSystemTime(1016)
      wakeAmbientFrames(tick, 600)
      const now = performance.now()
      displayFor(now, 600)
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(34)
      tick.mockClear()
      backgroundFor(now + 600, 2000)
      expect(tick.mock.calls.length).toBeLessThanOrEqual(3)
    })

    it('returns to the full rate at once when the window is in use again', () => {
      const tick = vi.fn()
      subscribe(tick, { kind: 'decoration' })
      display(1000)
      background()
      display(1008)
      expect(callbacks).toHaveLength(0)

      foreground()
      expect(callbacks).toHaveLength(1)
      tick.mockClear()
      displayFor(5000, 500)
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(29)
    })
  })

  it('runs nothing while the document is hidden, live or not, and tells listeners of each change', () => {
    const live = vi.fn()
    const listener = vi.fn()
    subscribe(live, { kind: 'live' })
    stops.push(subscribeToAmbientAnimationAllowed(listener))
    display(1000)

    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(ambientAnimationAllowed()).toBe(false)
    expect(callbacks).toHaveLength(0)
    vi.advanceTimersByTime(AMBIENT_SLOW_MS * 4)
    expect(callbacks).toHaveLength(0)
    expect(listener).toHaveBeenCalledTimes(1)

    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(ambientAnimationAllowed()).toBe(true)
    expect(callbacks).toHaveLength(1)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('says decoration is not allowed its full rate in a background window', () => {
    stops.push(subscribeToAmbientAnimationAllowed(() => {}))
    expect(ambientAnimationAllowed()).toBe(true)
    background()
    expect(ambientAnimationAllowed()).toBe(false)
  })

  it('drops a subscriber that throws and reports it, and everyone else keeps their frames', () => {
    const before = vi.fn()
    const after = vi.fn()
    const error = new Error('lost context')
    subscribe(before, { kind: 'decoration' })
    subscribe(
      () => {
        throw error
      },
      { kind: 'decoration' },
    )
    subscribe(after, { kind: 'decoration' })

    display(1000)
    expect(before).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
    // Reported where an uncaught error would be, outside the frame.
    expect(() => vi.advanceTimersByTime(0)).toThrow(error)

    displayFor(1017, 100)
    expect(after.mock.calls.length).toBeGreaterThan(3)
    expect(() => vi.advanceTimersByTime(0)).not.toThrow()
  })

  it('asks for one frame at a time when a tick subscribes, unsubscribes or wakes from inside a frame', () => {
    const late = vi.fn()
    let stopOther: () => void = () => {}
    const tick = vi.fn(() => {
      if (tick.mock.calls.length === 1) subscribe(late, { kind: 'status' })
      if (tick.mock.calls.length === 2) stopOther()
      wakeAmbientFrames(tick, 100)
    })
    subscribe(tick, { kind: 'status' })
    stopOther = subscribe(vi.fn(), { kind: 'decoration' })
    for (let i = 0; i < 6; i++) {
      display(1000 + i * (1000 / 60))
      expect(callbacks).toHaveLength(1)
    }
    expect(late).toHaveBeenCalled()
  })

  it('takes the next frame for a subscriber that woke inside a slow one', () => {
    let settling = true
    const tick = vi.fn(() => {
      if (settling) wakeAmbientFrames(tick, 100)
    })
    subscribe(tick, { kind: 'status' })
    background()
    vi.setSystemTime(1000)
    display(performance.now())
    // Woken from its own tick: a frame is asked for, not the slow clock's timer.
    expect(callbacks).toHaveLength(1)
    display(performance.now() + 17)
    expect(tick).toHaveBeenCalledTimes(2)
    settling = false
  })

  it('asks for no frames and keeps no timer once nothing is subscribed', () => {
    const stop = subscribe(vi.fn(), { kind: 'status' })
    display(1000)
    background()
    display(1008)
    expect(vi.getTimerCount()).toBe(1)
    stop()
    expect(callbacks).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
