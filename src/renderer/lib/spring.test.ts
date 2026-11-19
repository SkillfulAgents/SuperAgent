import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { animateSpring, type SpringConfig } from './spring'

/* A hand-cranked animation frame: callbacks queue up and `tick` runs them with
   the clock advanced, so a whole spring plays out synchronously. */
let frames = new Map<number, (now: number) => void>()
let nextId = 1
let now = 0

const tick = (ms = 16) => {
  now += ms
  const due = [...frames.values()]
  frames = new Map()
  for (const cb of due) cb(now)
}

const run = (maxFrames: number) => {
  for (let i = 0; i < maxFrames && frames.size > 0; i++) tick()
}

beforeEach(() => {
  frames = new Map()
  nextId = 1
  now = 0
  vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
    const id = nextId++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const critical = (stiffness: number, mass: number): SpringConfig => ({
  stiffness,
  mass,
  damping: 2 * Math.sqrt(stiffness * mass),
})

describe('animateSpring', () => {
  it('a critically damped spring settles on its target without crossing it', () => {
    const seen: number[] = []
    const done = vi.fn()
    animateSpring({ from: 224, to: 0, config: critical(580, 0.9), onUpdate: (v) => seen.push(v), onComplete: done })
    run(400)

    expect(done).toHaveBeenCalledTimes(1)
    expect(seen.at(-1)).toBe(0)
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0)
    // and it moved, rather than teleporting
    expect(seen.length).toBeGreaterThan(10)
  })

  it('an under-damped spring crosses its target before settling', () => {
    const seen: number[] = []
    const base = critical(580, 0.9)
    animateSpring({ from: 224, to: 0, config: { ...base, damping: base.damping * 0.62 }, onUpdate: (v) => seen.push(v) })
    run(400)

    expect(Math.min(...seen)).toBeLessThan(-1)
    expect(seen.at(-1)).toBe(0)
  })

  it('a starting velocity carries it past the target', () => {
    const seen: number[] = []
    animateSpring({ from: 0, to: 0, velocity: 800, config: critical(580, 0.9), onUpdate: (v) => seen.push(v) })
    run(400)

    expect(Math.max(...seen)).toBeGreaterThan(1)
    expect(seen.at(-1)).toBe(0)
  })

  it('completes at once when already at rest on the target', () => {
    const update = vi.fn()
    const done = vi.fn()
    animateSpring({ from: 5, to: 5, config: critical(580, 0.9), onUpdate: update, onComplete: done })
    tick()

    expect(update).toHaveBeenCalledWith(5)
    expect(done).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
  })

  it('cancel stops the frames and never reports completion', () => {
    const update = vi.fn()
    const done = vi.fn()
    const flight = animateSpring({ from: 224, to: 0, config: critical(580, 0.9), onUpdate: update, onComplete: done })
    tick()
    tick()
    const calls = update.mock.calls.length
    flight.cancel()
    run(50)

    expect(update.mock.calls.length).toBe(calls)
    expect(done).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })

  it('caps a late frame so a stall does not fling the value', () => {
    const seen: number[] = []
    animateSpring({ from: 224, to: 0, config: critical(580, 0.9), onUpdate: (v) => seen.push(v) })
    tick()
    tick(5000)

    expect(seen.at(-1)).toBeGreaterThanOrEqual(0)
    expect(seen.at(-1)).toBeLessThan(224)
  })
})
