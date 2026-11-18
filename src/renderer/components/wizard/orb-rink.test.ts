import { describe, expect, it } from 'vitest'
import { OrbRink, type Point } from './orb-rink'

const WIDTH = 600
const HEIGHT = 800
const DIAMETER = 100
/** The collision radius the rink uses: a little inside the drawn circle. */
const RADIUS = DIAMETER * 0.46

function rinkOf(homes: readonly Point[]): OrbRink {
  const rink = new OrbRink(homes)
  rink.resize(WIDTH, HEIGHT, DIAMETER)
  return rink
}

/** Step at 60fps for `seconds`, starting the clock at `from` ms. Returns the clock. */
function run(rink: OrbRink, seconds: number, from = 0): number {
  let now = from
  for (let frame = 0; frame <= seconds * 60; frame++) {
    now = from + (frame * 1000) / 60
    rink.step(now)
  }
  return now
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

describe('OrbRink', () => {
  it('sets the orbs out at their spots, clear of the boards', () => {
    const rink = rinkOf([{ x: 0.5, y: 0.5 }, { x: 0, y: 0 }, { x: 1, y: 1 }])
    expect(rink.position(0)).toMatchObject({ x: 300, y: 400 })
    expect(rink.position(1)).toMatchObject({ x: RADIUS, y: RADIUS })
    expect(rink.position(2)).toMatchObject({ x: WIDTH - RADIUS, y: HEIGHT - RADIUS })
  })

  it('keeps every orb on the ice and apart from the others', () => {
    const homes = Array.from({ length: 12 }, (_, i) => ({ x: (i % 4) / 3, y: Math.floor(i / 4) / 2 }))
    const rink = rinkOf(homes)
    // Throw one hard so the crowd is knocked about.
    rink.touch(RADIUS, RADIUS, RADIUS, RADIUS)
    rink.step(0)
    rink.release(3000, 2400)
    run(rink, 10, 16)
    homes.forEach((_, i) => {
      const p = rink.position(i)
      expect(p.x).toBeGreaterThanOrEqual(RADIUS - 0.001)
      expect(p.x).toBeLessThanOrEqual(WIDTH - RADIUS + 0.001)
      expect(p.y).toBeGreaterThanOrEqual(RADIUS - 0.001)
      expect(p.y).toBeLessThanOrEqual(HEIGHT - RADIUS + 0.001)
    })
    for (let i = 0; i < homes.length; i++) {
      for (let j = i + 1; j < homes.length; j++) {
        // One pass of separation a frame leaves at most a sliver of overlap in a pile-up.
        expect(distance(rink.position(i), rink.position(j))).toBeGreaterThan(RADIUS * 2 - 4)
      }
    }
  })

  it('pushes two orbs that start on top of each other apart', () => {
    const rink = rinkOf([{ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.5 }])
    run(rink, 0.5)
    expect(distance(rink.position(0), rink.position(1))).toBeGreaterThanOrEqual(RADIUS * 2 - 0.5)
  })

  it('finds the orb under the pointer, and none over empty ice', () => {
    const rink = rinkOf([{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }])
    expect(rink.orbUnder(150, 200)).toBe(0)
    expect(rink.orbUnder(450 + DIAMETER / 2 - 1, 600)).toBe(1)
    expect(rink.orbUnder(300, 400)).toBeNull()
  })

  it('carries a held orb with the pointer and lets it go with the flick', () => {
    const rink = rinkOf([{ x: 0.5, y: 0.5 }])
    // Grabbed 10px left of its centre: it keeps that offset from the pointer.
    rink.touch(290, 400, 290, 400)
    rink.step(0)
    expect(rink.held).toBe(0)
    rink.touch(190, 300, 290, 400)
    rink.step(16)
    expect(rink.position(0)).toMatchObject({ x: 200, y: 300 })

    rink.release(600, 0)
    expect(rink.held).toBeNull()
    rink.step(32)
    rink.step(48)
    const after = rink.position(0)
    expect(after.x).toBeGreaterThan(200 + 15)
    expect(Math.abs(after.y - 300)).toBeLessThan(1)
  })

  it('does not let a held orb be shoved by the ones it runs into', () => {
    const rink = rinkOf([{ x: 0.3, y: 0.5 }, { x: 0.6, y: 0.5 }])
    rink.touch(180, 400, 180, 400)
    rink.step(0)
    // Drag it straight through the other orb's spot.
    let now = 0
    for (let x = 180; x <= 360; x += 6) {
      now += 16
      rink.touch(x, 400, 180, 400)
      rink.step(now)
    }
    expect(rink.position(0)).toMatchObject({ x: 360, y: 400 })
    expect(rink.position(1).x).toBeGreaterThan(360 + RADIUS * 2 - 0.5)
  })

  it('scatters the orbs near a sweep across empty ice', () => {
    const rink = rinkOf([{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.9 }])
    const far = { ...rink.position(1) }
    // Press empty ice just left of the first orb and hold there.
    let now = 0
    for (let frame = 0; frame < 30; frame++) {
      rink.touch(235, 400, 235, 400)
      rink.step(now)
      now += 16
    }
    expect(rink.held).toBeNull()
    expect(rink.position(0).x).toBeGreaterThan(300 + 20)
    // Out of the sweep's reach: only its own slow glide has moved it.
    expect(distance(rink.position(1), far)).toBeLessThan(20)
  })

  it('brings the orbs inside new boards without setting them out again', () => {
    const rink = rinkOf([{ x: 0.2, y: 0.2 }, { x: 0.9, y: 0.9 }])
    rink.resize(300, 400, 80)
    const r = 80 * 0.46
    // One is still on the ice where it was; the one now off it is brought to the edge.
    expect(rink.position(0)).toMatchObject({ x: 120, y: 160 })
    expect(rink.position(1)).toMatchObject({ x: 300 - r, y: 400 - r })
    // Wider boards again: nobody goes back to their starting spot.
    rink.resize(WIDTH, HEIGHT, DIAMETER)
    expect(rink.position(0)).toMatchObject({ x: 120, y: 160 })
    expect(rink.position(1)).toMatchObject({ x: 300 - r, y: 400 - r })
  })

  it('holds still across a stalled frame instead of leaping', () => {
    const rink = rinkOf([{ x: 0.5, y: 0.5 }])
    rink.step(0)
    rink.touch(300, 400, 300, 400)
    rink.step(16)
    rink.release(600, 0)
    const before = { ...rink.position(0) }
    // Ten seconds late: one step of at most a thirtieth of a second.
    rink.step(10_016)
    expect(distance(rink.position(0), before)).toBeLessThanOrEqual(600 / 30 + 0.001)
  })
})
