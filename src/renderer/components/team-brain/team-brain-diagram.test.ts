import { describe, expect, it } from 'vitest'
import type { AgentAvatar } from '@shared/lib/types/agent-avatar'
import { pickDiagramAgents } from './team-brain-diagram'

const agent = (name: string, color: AgentAvatar['color'], shape: AgentAvatar['shape']) => ({ name, avatar: { color, shape } })
const names = (agents: { name: string }[]) => agents.map((a) => a.name)

describe('pickDiagramAgents', () => {
  it('shows the most agents it can with no colour or shape twice, in palette order', () => {
    const agents = [
      agent('Planned', 'tonal-orange', 'circle'),
      agent('Recruiter', 'tonal-cobalt', 'circle'),
      agent('Story Writer', 'tonal-orange', 'hexagon'),
      agent('Bug Wizard', 'tonal-blush', 'circle'),
      agent('SEO', 'tonal-teal', 'squircle'),
      agent('Ads', 'tonal-pink', 'pill'),
      agent('Market Watch', 'tonal-forest', 'arch'),
      agent('Blog', 'tonal-blue', 'diamond'),
      agent('Churn', 'tonal-black', 'diamond'),
    ]
    const picked = pickDiagramAgents(agents, 10)
    // Taking Planned first would block both Story Writer and Recruiter; the matching keeps six.
    expect(picked).toHaveLength(6)
    expect(new Set(picked.map((a) => a.avatar.color)).size).toBe(6)
    expect(new Set(picked.map((a) => a.avatar.shape)).size).toBe(6)
    expect(names(picked)).toEqual(['Story Writer', 'Market Watch', 'SEO', 'Blog', 'Recruiter', 'Ads'])
  })

  it('brings in repeats only to reach the minimum, new colours first', () => {
    const agents = [
      agent('One', 'tonal-orange', 'circle'),
      agent('Two', 'tonal-blue', 'circle'),
      agent('Three', 'tonal-orange', 'circle'),
      { name: 'No avatar', avatar: null },
    ]
    expect(names(pickDiagramAgents(agents, 10))).toEqual(['One'])
    expect(names(pickDiagramAgents(agents, 10, 3))).toEqual(['One', 'Three', 'Two'])
  })
})
