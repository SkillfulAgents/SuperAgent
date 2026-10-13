import { describe, expect, it } from 'vitest'

import { agentAvatarId, orbRestingPhi } from './agent-avatar'
import { avatarForId } from './avatar-ids'
import { DEFAULT_ORBS } from './avatar-orbs'
import { ORB_SHAPES } from './orb-shapes'

describe('agentAvatarId', () => {
  const slugs = Array.from({ length: 400 }, (_, i) => `agent-${i.toString(36)}-x${(i * 7919).toString(36)}`)

  it('gives an agent the same colour and shape every time, from its slug alone', () => {
    expect(agentAvatarId('abc123')).toBe(agentAvatarId('abc123'))
    expect(avatarForId(agentAvatarId('abc123'))).not.toBeNull()
  })

  it('draws from the offered colours and every shape', () => {
    const sources = slugs.map(slug => avatarForId(agentAvatarId(slug))!)
    for (const source of sources) expect(DEFAULT_ORBS).toContain(source.orb)
    expect(new Set(sources.map(source => source.orb)).size).toBe(DEFAULT_ORBS.length)
    expect(new Set(sources.map(source => source.shape.name)).size).toBe(ORB_SHAPES.length)
  })

  it('picks colour and shape independently of each other', () => {
    // Every colour turns up with more than one shape.
    const shapesByColour = new Map<string, Set<string>>()
    for (const slug of slugs) {
      const { orb, shape } = avatarForId(agentAvatarId(slug))!
      shapesByColour.set(orb.name, (shapesByColour.get(orb.name) ?? new Set()).add(shape.name))
    }
    for (const shapes of shapesByColour.values()) expect(shapes.size).toBeGreaterThan(1)
  })
})

describe('orbRestingPhi', () => {
  it('is stable per seed', () => {
    expect(orbRestingPhi('abc')).toBe(orbRestingPhi('abc'))
    expect(orbRestingPhi('abc')).toBeGreaterThanOrEqual(-240)
    expect(orbRestingPhi('abc')).toBeLessThan(60)
  })
})
