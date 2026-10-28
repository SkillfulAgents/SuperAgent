import { describe, expect, it } from 'vitest'
import { agentHomeSearchFor, isTeamBrainAgentHome } from './team-brain-agent-home'

describe('the Team Brain agent\'s Agent Home', () => {
  it('opens for a Team Brain agent and leaves other agents\' links as they were', () => {
    expect(agentHomeSearchFor({ teamBrain: { volumeId: 'v1' } })).toEqual({ from: '/team-brain' })
    expect(agentHomeSearchFor({})).toBeUndefined()
  })

  it('is told by its search alone', () => {
    expect(isTeamBrainAgentHome({ from: '/team-brain' })).toBe(true)
    expect(isTeamBrainAgentHome({ from: '/settings' })).toBe(false)
    expect(isTeamBrainAgentHome({})).toBe(false)
  })

})
