import { describe, expect, it } from 'vitest'
import { buildAgentMemberAgents } from './agent-member-agents-service'

const agents = [
  { slug: 'scout', name: 'Research Scout', avatar: { color: 'tonal-grey', shape: 'hexagon' } as const },
  { slug: 'triage', name: 'Inbox Triage', avatar: { color: 'tonal-green', shape: 'circle' } as const },
  { slug: 'notes', name: 'Release Notes', avatar: null },
  { slug: 'desk', name: 'Deal Desk' },
]
const policy = (callerAgentSlug: string, operation: 'invoke' | 'read', targetAgentSlug: string | null, decision: 'allow' | 'review' | 'block') =>
  ({ callerAgentSlug, operation, targetAgentSlug, decision })

function roles(input: Partial<Parameters<typeof buildAgentMemberAgents>[0]>) {
  const byAgent = buildAgentMemberAgents({ agents, policies: [], authMode: false, aclRows: [], ...input })
  return Object.fromEntries(Object.entries(byAgent).map(([slug, members]) => [slug, members.map((m) => `${m.slug}:${m.role}`)]))
}

describe('buildAgentMemberAgents', () => {
  it('lists the agents that send without asking as Users and the ones that only read as Viewers', () => {
    expect(roles({
      policies: [
        policy('triage', 'invoke', 'scout', 'allow'),
        policy('notes', 'read', 'scout', 'allow'),
        policy('desk', 'invoke', 'scout', 'review'),
      ],
    })).toEqual({ scout: ['triage:user', 'notes:viewer'] })
  })

  it('carries what a stack draws: name, display slug and avatar', () => {
    const byAgent = buildAgentMemberAgents({ agents, policies: [policy('triage', 'invoke', 'scout', 'allow')], authMode: false, aclRows: [] })
    expect(byAgent.scout).toEqual([{
      slug: 'triage',
      displaySlug: expect.stringContaining('triage'),
      name: 'Inbox Triage',
      avatar: { color: 'tonal-green', shape: 'circle' },
      role: 'user',
    }])
  })

  it("applies a caller's rule for every agent unless the target has its own", () => {
    expect(roles({
      policies: [
        policy('triage', 'invoke', null, 'allow'),
        policy('triage', 'invoke', 'notes', 'review'),
      ],
    })).toEqual({ scout: ['triage:user'], desk: ['triage:user'] })
  })

  it('leaves out a blocked agent even when it may read', () => {
    expect(roles({
      policies: [
        policy('triage', 'invoke', 'scout', 'block'),
        policy('triage', 'read', 'scout', 'allow'),
      ],
    })).toEqual({})
  })

  it('lets the latest write win', () => {
    expect(roles({
      policies: [
        policy('triage', 'invoke', 'scout', 'allow'),
        policy('triage', 'invoke', 'scout', 'review'),
      ],
    })).toEqual({})
  })

  it('in auth mode, counts an agent only where one of its owners uses the other', () => {
    const policies = [policy('triage', 'invoke', 'scout', 'allow'), policy('notes', 'invoke', 'scout', 'allow')]
    expect(roles({
      authMode: true,
      policies,
      aclRows: [
        { agentSlug: 'scout', userId: 'ada', role: 'user' },
        { agentSlug: 'triage', userId: 'ada', role: 'owner' },
        { agentSlug: 'notes', userId: 'lee', role: 'owner' },
        { agentSlug: 'scout', userId: 'lee', role: 'viewer' },
      ],
    })).toEqual({ scout: ['triage:user'] })
  })
})
