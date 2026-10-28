import { describe, expect, it } from 'vitest'

import { SLEEP_PACE, blendFrames, doneFrame, idleFrame, needsInputFrame, restFrame, sleepingFrame } from './orb-states'

describe('orb states', () => {
  it('idle glances somewhere new every 2.2s, from the agent’s own direction, and blinks', () => {
    expect(idleFrame(0, -90).phi).toBe(-90)
    expect(idleFrame(1.4, -90).phi).toBe(-90) // holds, then turns between 1.5s and 2.1s
    expect(idleFrame(2.2, -90).phi).toBeCloseTo(-30)
    expect(idleFrame(3.1, -90).blink).toBeCloseTo(0.1)
  })

  it('sleeps as a slower idle: the same glances and blinks, further apart', () => {
    for (const t of [0, 1.8, 3.1, 7.4]) expect(sleepingFrame(t * SLEEP_PACE, -90)).toEqual(idleFrame(t, -90))
    // Idle has blinked by 3.1s; asleep, that blink is still to come.
    expect(idleFrame(3.1, -90).blink).toBeCloseTo(0.1)
    expect(sleepingFrame(3.1, -90).blink).toBe(1)
    expect(sleepingFrame(3.1 * SLEEP_PACE, -90).blink).toBeCloseTo(0.1)
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
