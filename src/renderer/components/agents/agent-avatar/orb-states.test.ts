import { describe, expect, it } from 'vitest'

import { blendFrames, doneFrame, idleFrame, needsInputFrame, restFrame, sleepingFrame } from './orb-states'

describe('orb states', () => {
  it('idle glances somewhere new every 2.2s, from the agent’s own direction, and blinks', () => {
    expect(idleFrame(0, -90).phi).toBe(-90)
    expect(idleFrame(1.4, -90).phi).toBe(-90) // holds, then turns between 1.5s and 2.1s
    expect(idleFrame(2.2, -90).phi).toBeCloseTo(-30)
    expect(idleFrame(3.1, -90).blink).toBeCloseTo(0.1)
  })

  it('sleeps upright with its face shut to a slit, centred and low, light breathing over 4s', () => {
    const inBreath = sleepingFrame(1)
    const outBreath = sleepingFrame(3)
    expect(inBreath.phi).toBe(90) // straight down
    expect(inBreath.distance).toBe(0.7)
    expect(inBreath.blink).toBe(0.25)
    expect(inBreath.saturation).toBe(0.85)
    expect(inBreath.glowOpacity).toBeCloseTo(0.85)
    expect(outBreath.glowOpacity).toBeCloseTo(0.25)
  })

  it('done nods once with a swell of light, then rests face-up and a touch brighter', () => {
    expect(doneFrame(0.3).distance).toBeCloseTo(0.55)
    expect(doneFrame(0.55).glow).toBeGreaterThan(1.15)
    const resting = doneFrame(3)
    expect(resting.distance).toBeLessThan(-0.2)
    expect(resting.glow).toBeCloseTo(1.08)
  })

  it('needs input taps twice, then hops, every 3.6s', () => {
    expect(needsInputFrame(0.11).scale).toBeGreaterThan(1.05) // first tap
    expect(needsInputFrame(1.25).jump).toBeCloseTo(-0.24) // top of the hop
    expect(needsInputFrame(1.25 + 3.6).jump).toBeCloseTo(-0.24)
    expect(needsInputFrame(3).jump).toBe(0)
  })

  it('blends every value, turning the gaze the short way', () => {
    const a = restFrame(170)
    const b = { ...restFrame(-170), jump: -0.2 }
    const mid = blendFrames(a, b, 0.5)
    expect(mid.jump).toBeCloseTo(-0.1)
    expect(mid.phi).toBeCloseTo(180)
  })
})
