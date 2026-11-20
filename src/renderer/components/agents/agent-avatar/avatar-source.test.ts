import { describe, expect, it } from 'vitest'
import { OFFERED_ORBS } from '@shared/lib/types/agent-avatar-orbs'
import { orbGround } from './avatar-source'

const orb = (name: string) => OFFERED_ORBS.find(candidate => candidate.name === name)!

describe('orbGround', () => {
  it('is a pale tint of the orb’s own rim: the rim taken 85% of the way to white', () => {
    expect(orb('tonal-red').rim).toBe('#DE0223')
    expect(orbGround(orb('tonal-red'))).toBe('#FAD9DE')
  })

  it('lifts even the black orb’s ground clear of its rim', () => {
    expect(orbGround(orb('tonal-black'))).toBe('#DCDBDB')
  })
})
