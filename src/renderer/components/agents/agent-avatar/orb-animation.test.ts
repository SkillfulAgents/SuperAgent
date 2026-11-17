import { describe, expect, it } from 'vitest'
import { OrbAnimation } from './orb-animation'
import { orbShape } from '@shared/lib/types/agent-avatar-shapes'
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

describe('OrbAnimation pace', () => {
  it('asks for 30 paints a second while it only glances or sleeps, and 60 for quick motion', () => {
    expect(animate('idle').pace).toBe(30)
    expect(animate('sleeping').pace).toBe(30)
    expect(animate('working').pace).toBe(60)
    expect(animate('needs-input').pace).toBe(60)
    expect(animate('done').pace).toBe(60)
  })

  it('takes 60 while following the pointer, changing state or rolling, then settles back', () => {
    const followed = animate('idle')
    followed.lookAt(40, 0, 24, 0)
    expect(followed.pace).toBe(60)

    const changing = animate('working')
    changing.configure({ shape: orbShape('circle'), diameter: 24, restingPhi: -90, state: 'idle', reduced: false }, 100)
    expect(changing.pace).toBe(60)

    const rolled = animate('idle')
    rolled.rollBy(90)
    expect(rolled.pace).toBe(60)
    for (let now = 16; now <= 2000; now += 16) rolled.advance(now)
    expect(rolled.pace).toBe(30)
  })

  it('drops a finished orb to 30 once its nod is over', () => {
    const done = animate('done')
    done.advance(500)
    expect(done.pace).toBe(60)
    done.advance(1600)
    expect(done.pace).toBe(30)
  })
})

describe('OrbAnimation settling', () => {
  const config = (state: OrbState) => ({ shape: orbShape('circle'), diameter: 24, restingPhi: -90, state, reduced: false })

  it('is settling while a change of state plays out, and not once it has', () => {
    const orb = animate('idle')
    for (let now = 16; now <= 1000; now += 16) orb.advance(now)
    expect(orb.settling).toBe(false)

    // The dots come out, and then it types for as long as the work goes on.
    orb.configure(config('working'), 1000)
    expect(orb.settling).toBe(true)
    let now = 1000
    for (; now <= 3000; now += 16) orb.advance(now)
    expect(orb.settling).toBe(false)

    // They gather back in, and it blends to rest.
    orb.configure(config('idle'), now)
    expect(orb.settling).toBe(true)
    for (; now <= 6000; now += 16) orb.advance(now)
    expect(orb.settling).toBe(false)
  })

  it('is settling from the start when it is made already working', () => {
    expect(animate('working').settling).toBe(true)
  })
})
