import { describe, expect, it } from 'vitest'
import { AGENT_AVATAR_COLORS, AGENT_AVATAR_SHAPES, DEFAULT_AGENT_AVATAR_COLORS } from '@shared/lib/types/agent-avatar'
import { orbRestingPhi } from './agent-avatar'
import { avatarSource } from './avatar-source'
import { DEFAULT_ORBS, OFFERED_ORBS } from './avatar-orbs'
import { ORB_SHAPES } from './orb-shapes'

it('renders every persisted color and shape, including every randomly assigned default', () => {
  expect(OFFERED_ORBS.map(orb => orb.name)).toEqual([...AGENT_AVATAR_COLORS])
  expect(DEFAULT_ORBS.map(orb => orb.name)).toEqual([...DEFAULT_AGENT_AVATAR_COLORS])
  expect(ORB_SHAPES.map(shape => shape.name)).toEqual([...AGENT_AVATAR_SHAPES])
  for (const color of AGENT_AVATAR_COLORS) {
    for (const shape of AGENT_AVATAR_SHAPES) {
      const source = avatarSource({ color, shape })
      expect(source.orb.name).toBe(color)
      expect(source.shape.name).toBe(shape)
    }
  }
})

describe('orbRestingPhi', () => {
  it('keeps the decorative resting gaze stable per seed', () => {
    expect(orbRestingPhi('abc')).toBe(orbRestingPhi('abc'))
    expect(orbRestingPhi('abc')).toBeGreaterThanOrEqual(-240)
    expect(orbRestingPhi('abc')).toBeLessThan(60)
  })
})
