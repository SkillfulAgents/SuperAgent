import { describe, expect, it } from 'vitest'
import { usesTeamBrain } from './team-brain-store'

describe('usesTeamBrain', () => {
  it('gives every agent Team Brain until turned off one by one', () => {
    const choices = { everyAgent: true, agents: { planner: false } }
    expect(usesTeamBrain(choices, 'writer')).toBe(true)
    expect(usesTeamBrain(choices, 'planner')).toBe(false)
  })
})
