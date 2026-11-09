import { describe, expect, it } from 'vitest'
import { OrbAnimation } from './orb-animation'
import { orbShape } from './orb-shapes'
import type { OrbState } from './orb-states'

const animate = (state: OrbState) =>
  new OrbAnimation({ shape: orbShape('circle'), diameter: 24, restingPhi: -90, state, reduced: false }, 0)

/** Advances a rolled and an unrolled orb in step and returns how far apart their gazes end up. */
function rolledBy(state: OrbState, degrees: number): number {
  const still = animate(state)
  const rolled = animate(state)
  rolled.rollBy(degrees)
  let a = still.last
  let b = rolled.last
  for (let now = 16; now <= 1000; now += 16) {
    a = still.advance(now)
    b = rolled.advance(now)
  }
  return b.phi - a.phi
}

describe('OrbAnimation roll', () => {
  it('rolls the face round the rim, clockwise for positive degrees', () => {
    expect(rolledBy('idle', 90)).toBeCloseTo(90, 1)
    expect(rolledBy('idle', -90)).toBeCloseTo(-90, 1)
    expect(rolledBy('needs-input', 45)).toBeCloseTo(45, 1)
  })

  it('holds still while working or asleep', () => {
    expect(rolledBy('working', 90)).toBe(0)
    expect(rolledBy('sleeping', 90)).toBe(0)
  })
})
