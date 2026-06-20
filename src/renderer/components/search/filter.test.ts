import { describe, it, expect } from 'vitest'
import { filterAgentsAndSessions, flattenGroups, getRecentAgents } from './filter'
import type { ApiAgent, ApiAgentDashboard, ApiSession } from '@shared/lib/types/api'

function agent(
  slug: string,
  name: string,
  lastActivityAt?: Date,
  dashboards?: ApiAgentDashboard[]
): ApiAgent {
  return {
    slug,
    name,
    createdAt: new Date(0),
    status: 'stopped',
    containerPort: null,
    lastActivityAt: lastActivityAt ?? undefined,
    dashboards,
  }
}

function session(id: string, agentSlug: string, name: string, lastActivityAt?: Date): ApiSession {
  return {
    id,
    agentSlug,
    name,
    createdAt: new Date(0),
    lastActivityAt: lastActivityAt ?? new Date(0),
    messageCount: 0,
    isActive: false,
    isAwaitingInput: false,
    hasUnreadNotifications: false,
  } as ApiSession
}

describe('filterAgentsAndSessions', () => {
  const alpha = agent('alpha', 'Alpha Bot', new Date('2025-01-01'))
  const beta = agent('beta', 'Beta Worker', new Date('2025-01-02'))
  const sessions = {
    alpha: [session('s1', 'alpha', 'Refactor login'), session('s2', 'alpha', 'Database backup')],
    beta: [session('s3', 'beta', 'Login analytics'), session('s4', 'beta', 'Daily report')],
  }

  it('empty query returns empty array', () => {
    const groups = filterAgentsAndSessions([alpha, beta], sessions, '')
    expect(groups).toHaveLength(0)
  })

  it('matches agent name case-insensitively', () => {
    const groups = filterAgentsAndSessions([alpha, beta], sessions, 'ALPHA')
    expect(groups).toHaveLength(1)
    expect(groups[0].agent.slug).toBe('alpha')
    expect(groups[0].matchedAgent).toBe(true)
    expect(groups[0].dashboards).toEqual([])
    expect(groups[0].sessions).toEqual([])
  })

  it('surfaces a non-matching agent because one of its sessions matches', () => {
    const groups = filterAgentsAndSessions([alpha, beta], sessions, 'login')
    expect(groups).toHaveLength(2)
    const alphaGroup = groups.find((g) => g.agent.slug === 'alpha')!
    expect(alphaGroup.matchedAgent).toBe(false)
    expect(alphaGroup.sessions.map((s) => s.id)).toEqual(['s1'])

    const betaGroup = groups.find((g) => g.agent.slug === 'beta')!
    expect(betaGroup.matchedAgent).toBe(false)
    expect(betaGroup.sessions.map((s) => s.id)).toEqual(['s3'])
  })

  it('matched agent with no matching sessions returns the agent only', () => {
    const groups = filterAgentsAndSessions([alpha, beta], sessions, 'alpha')
    expect(groups).toHaveLength(1)
    expect(groups[0].agent.slug).toBe('alpha')
    expect(groups[0].matchedAgent).toBe(true)
    expect(groups[0].dashboards).toEqual([])
    expect(groups[0].sessions).toEqual([])
  })

  it('surfaces a non-matching agent because one of its dashboards matches', () => {
    const groups = filterAgentsAndSessions(
      [
        agent('alpha', 'Alpha Bot', new Date('2025-01-01'), [
          { slug: 'sales-overview', name: 'Sales Overview' },
          { slug: 'ops', name: 'Operations' },
        ]),
        beta,
      ],
      sessions,
      'sales'
    )

    expect(groups).toHaveLength(1)
    expect(groups[0].agent.slug).toBe('alpha')
    expect(groups[0].matchedAgent).toBe(false)
    expect(groups[0].dashboards.map((d) => d.slug)).toEqual(['sales-overview'])
    expect(groups[0].sessions).toEqual([])
  })

  it('matches dashboard slugs when the display name does not match', () => {
    const groups = filterAgentsAndSessions(
      [agent('alpha', 'Alpha Bot', new Date('2025-01-01'), [{ slug: 'revops', name: 'Metrics' }])],
      {},
      'rev'
    )

    expect(groups).toHaveLength(1)
    expect(groups[0].dashboards.map((d) => d.slug)).toEqual(['revops'])
  })

  it('falls back to dashboard summary names and slugs', () => {
    const legacyAgent: ApiAgent = {
      ...agent('legacy', 'Legacy Bot', new Date('2025-01-01')),
      dashboards: undefined,
      dashboardNames: ['Legacy Dashboard'],
      dashboardSlugs: ['legacy-dashboard'],
    }

    const groups = filterAgentsAndSessions([legacyAgent], {}, 'legacy dashboard')

    expect(groups).toHaveLength(1)
    expect(groups[0].dashboards).toEqual([
      { slug: 'legacy-dashboard', name: 'Legacy Dashboard' },
    ])
  })

  it('hides agents with no name match and no session match', () => {
    const groups = filterAgentsAndSessions([alpha, beta], sessions, 'zzz')
    expect(groups).toHaveLength(0)
  })

  it('whitespace-only query is treated as empty', () => {
    const groups = filterAgentsAndSessions([alpha, beta], sessions, '   ')
    expect(groups).toHaveLength(0)
  })
})

describe('getRecentAgents', () => {
  it('returns agents sorted by lastActivityAt descending, limited to 10', () => {
    const agents = Array.from({ length: 12 }, (_, i) =>
      agent(`a${i}`, `Agent ${i}`, new Date(2025, 0, i + 1))
    )
    const sessions: Record<string, ApiSession[]> = {}
    const result = getRecentAgents(agents, sessions)
    expect(result).toHaveLength(10)
    expect(result[0].agent.slug).toBe('a11')
    expect(result[9].agent.slug).toBe('a2')
  })

  it('excludes agents without lastActivityAt', () => {
    const agents = [
      agent('active', 'Active', new Date('2025-03-01')),
      agent('inactive', 'Inactive'),
    ]
    const result = getRecentAgents(agents, {})
    expect(result).toHaveLength(1)
    expect(result[0].agent.slug).toBe('active')
  })

  it('sorts sessions by lastActivityAt descending and limits to 10', () => {
    const a = agent('a', 'Agent A', new Date('2025-01-01'))
    const allSessions = Array.from({ length: 12 }, (_, i) =>
      session(`s${i}`, 'a', `Session ${i}`, new Date(2025, 0, i + 1))
    )
    const result = getRecentAgents([a], { a: allSessions })
    expect(result[0].sessions).toHaveLength(10)
    expect(result[0].sessions[0].id).toBe('s11')
    expect(result[0].sessions[9].id).toBe('s2')
  })

  it('includes dashboards for recent agents', () => {
    const a = agent('a', 'Agent A', new Date('2025-01-01'), [
      { slug: 'overview', name: 'Overview' },
    ])

    const result = getRecentAgents([a], {})

    expect(result[0].dashboards).toEqual([{ slug: 'overview', name: 'Overview' }])
  })
})

describe('flattenGroups', () => {
  const alpha = agent('alpha', 'Alpha', new Date('2025-01-01'))
  const d1: ApiAgentDashboard = { slug: 'dash-one', name: 'Dash one' }
  const s1 = session('s1', 'alpha', 'one')
  const s2 = session('s2', 'alpha', 'two')

  it('without expandedSlugs, emits agent and all dashboards/sessions', () => {
    const flat = flattenGroups([{ agent: alpha, matchedAgent: true, dashboards: [d1], sessions: [s1, s2] }])
    expect(flat).toEqual([
      { kind: 'agent', agent: alpha },
      { kind: 'dashboard', agent: alpha, dashboard: d1 },
      { kind: 'session', agent: alpha, session: s1 },
      { kind: 'session', agent: alpha, session: s2 },
    ])
  })

  it('with expandedSlugs, only emits dashboards/sessions for expanded agents', () => {
    const flat = flattenGroups(
      [{ agent: alpha, matchedAgent: true, dashboards: [d1], sessions: [s1, s2] }],
      new Set()
    )
    expect(flat).toEqual([{ kind: 'agent', agent: alpha }])
  })

  it('with expandedSlugs containing the agent, emits sessions', () => {
    const flat = flattenGroups(
      [{ agent: alpha, matchedAgent: true, dashboards: [d1], sessions: [s1, s2] }],
      new Set(['alpha'])
    )
    expect(flat).toEqual([
      { kind: 'agent', agent: alpha },
      { kind: 'dashboard', agent: alpha, dashboard: d1 },
      { kind: 'session', agent: alpha, session: s1 },
      { kind: 'session', agent: alpha, session: s2 },
    ])
  })

  it('emits an agent header even when it has no sessions', () => {
    const flat = flattenGroups([{ agent: alpha, matchedAgent: true, dashboards: [], sessions: [] }])
    expect(flat).toEqual([{ kind: 'agent', agent: alpha }])
  })
})
