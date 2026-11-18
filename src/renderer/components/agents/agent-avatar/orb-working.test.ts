import { describe, expect, it } from 'vitest'

import { becomeTheDots, DOTS_CYCLE, DOTS_GATHER, dotUnit, TYPING_FROM, TYPING_LOOP, workingPosition } from './orb-working'

describe('become the dots', () => {
  it('starts and ends at the resting orb, so the loop is seamless', () => {
    for (const frame of [becomeTheDots(0, 40), becomeTheDots(DOTS_CYCLE - 0.001, 40)]) {
      expect(frame).toMatchObject({ distance: 1, faceOpacity: 1, scale: 1, opacity: 1, dots: [] })
      expect(frame.blink).toBeCloseTo(1)
    }
  })

  it('becomes three typing dots while the body is gone', () => {
    const frame = becomeTheDots(2, 150)
    expect(frame.faceOpacity).toBe(0)
    expect(frame.opacity).toBe(0)
    expect(frame.dots).toHaveLength(3)
    const [left, middle, right] = frame.dots
    expect(left.x).toBeCloseTo(-35)
    expect(middle.x).toBe(0)
    expect(right.x).toBeCloseTo(35)
    for (const dot of frame.dots) {
      expect(dot.size).toBeCloseTo(26)
      expect(dot.opacity).toBe(1)
      expect(dot.y).toBeLessThanOrEqual(0)
      expect(dot.y).toBeGreaterThanOrEqual(-10)
    }
  })

  it('hands the face to the middle dot at full size, then shrinks it', () => {
    const handoff = becomeTheDots(0.5, 100)
    expect(handoff.dots[1].size).toBeCloseTo(50)
    expect(handoff.dots[0].opacity).toBeCloseTo(0)
    expect(becomeTheDots(1.1, 100).dots[1].size).toBeLessThan(25)
  })

  it('gathers back and regrows the body from the gather point', () => {
    expect(becomeTheDots(DOTS_GATHER, 100).dots[0].x).toBeLessThan(0)
    const regrowing = becomeTheDots(4.7, 100)
    expect(regrowing.dots.every(dot => Math.abs(dot.x) < 1e-9)).toBe(true)
    expect(regrowing.opacity).toBe(1)
    expect(regrowing.scale).toBeGreaterThan(0.2)
  })

  it('blinks as the face returns', () => {
    expect(becomeTheDots(5.3, 40).blink).toBeCloseTo(0.1)
  })

  it('gives the sidebar’s 27px orb 7px dots and keeps the design’s size at 150px', () => {
    expect(26 * dotUnit(27)).toBeCloseTo(7)
    expect(dotUnit(150)).toBeCloseTo(1)
    const sidebar = becomeTheDots(2, 27).dots
    expect(sidebar[1].size).toBeCloseTo(7)
    // Edge-to-edge gap between neighbouring dots: about 2.4px.
    expect(sidebar[2].x - sidebar[1].x - 7).toBeCloseTo(2.4, 1)
  })

  it('keeps showing the dots for as long as work goes on — the avatar never comes back mid-work', () => {
    for (let elapsed = TYPING_FROM; elapsed < 120; elapsed += 0.037) {
      const position = workingPosition(elapsed)
      expect(position).toBeLessThan(DOTS_GATHER)
      const frame = becomeTheDots(position, 27)
      expect(frame.opacity).toBe(0)
      expect(frame.dots).toHaveLength(3)
    }
  })

  it('plays the intro once, then loops the typing without a hitch', () => {
    expect(workingPosition(0.8)).toBe(0.8)
    const justBefore = becomeTheDots(workingPosition(TYPING_FROM + TYPING_LOOP - 0.001), 150).dots
    const justAfter = becomeTheDots(workingPosition(TYPING_FROM + TYPING_LOOP + 0.001), 150).dots
    justBefore.forEach((dot, i) => {
      expect(Math.abs(dot.y - justAfter[i].y)).toBeLessThan(0.2)
      expect(dot.x).toBeCloseTo(justAfter[i].x)
    })
  })
})
