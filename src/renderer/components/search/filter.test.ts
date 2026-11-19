import { describe, it, expect } from 'vitest'
import { flattenSections, getRecent, searchAll, RECENT_AGENTS_LIMIT, RECENT_SESSIONS_LIMIT } from './filter'
import type { ApiAgent, ApiAgentDashboard, ApiSession } from '@shared/lib/types/api'

function agent(
  slug: string,
  name: string,
  lastActivityAt?: Date,
  dashboards?: ApiAgentDashboard[]
): ApiAgent {
  return {
    avatar: { color: 'tonal-blue', shape: 'circle' } as const,
    slug,
    displaySlug: slug,
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
    isActive: false,
    isAwaitingInput: false,
    hasUnreadNotifications: false,
  } as ApiSession
}

describe('searchAll', () => {
  const alpha = agent('alpha', 'Alpha Bot', new Date('2025-01-01'))
  const beta = agent('beta', 'Beta Worker', new Date('2025-01-02'))
  const sessions = {
    alpha: [
      session('s1', 'alpha', 'Refactor login', new Date('2025-01-01')),
      session('s2', 'alpha', 'Database backup', new Date('2025-01-02')),
    ],
    beta: [
      session('s3', 'beta', 'Login analytics', new Date('2025-01-03')),
      session('s4', 'beta', 'Daily report', new Date('2025-01-04')),
    ],
  }

  it('empty query returns nothing in every section', () => {
    expect(searchAll([alpha, beta], sessions, '')).toEqual({ agents: [], sessions: [], dashboards: [] })
  })

  it('whitespace-only query is treated as empty', () => {
    expect(searchAll([alpha, beta], sessions, '   ')).toEqual({ agents: [], sessions: [], dashboards: [] })
  })

  it('matches agent name case-insensitively', () => {
    const result = searchAll([alpha, beta], sessions, 'ALPHA')
    expect(result.agents.map((a) => a.slug)).toEqual(['alpha'])
    expect(result.sessions).toEqual([])
    expect(result.dashboards).toEqual([])
  })

  it('lists a matching session under its agent without listing the agent', () => {
    const result = searchAll([alpha, beta], sessions, 'backup')
    expect(result.agents).toEqual([])
    expect(result.sessions).toEqual([{ agent: alpha, session: sessions.alpha[1] }])
  })

  it('lists matching sessions from every agent, newest first', () => {
    const result = searchAll([alpha, beta], sessions, 'login')
    expect(result.agents).toEqual([])
    expect(result.sessions.map((r) => [r.agent.slug, r.session.id])).toEqual([
      ['beta', 's3'],
      ['alpha', 's1'],
    ])
  })

  it('does not list the sessions of an agent whose name matches', () => {
    const result = searchAll([alpha, beta], sessions, 'alpha')
    expect(result.agents.map((a) => a.slug)).toEqual(['alpha'])
    expect(result.sessions).toEqual([])
  })

  it('lists a matching dashboard with its agent', () => {
    const withDashboards = agent('alpha', 'Alpha Bot', new Date('2025-01-01'), [
      { slug: 'sales-overview', name: 'Sales Overview' },
      { slug: 'ops', name: 'Operations' },
    ])
    const result = searchAll([withDashboards, beta], sessions, 'sales')

    expect(result.agents).toEqual([])
    expect(result.sessions).toEqual([])
    expect(result.dashboards).toEqual([
      { agent: withDashboards, dashboard: { slug: 'sales-overview', name: 'Sales Overview' } },
    ])
  })

  it('matches dashboard slugs when the display name does not match', () => {
    const result = searchAll(
      [agent('alpha', 'Alpha Bot', new Date('2025-01-01'), [{ slug: 'revops', name: 'Metrics' }])],
      {},
      'rev'
    )
    expect(result.dashboards.map((r) => r.dashboard.slug)).toEqual(['revops'])
  })

  it('returns nothing when no agent, session or dashboard matches', () => {
    expect(searchAll([alpha, beta], sessions, 'zzz')).toEqual({ agents: [], sessions: [], dashboards: [] })
  })
})

describe('getRecent', () => {
  it('returns agents sorted by lastActivityAt descending, limited to RECENT_AGENTS_LIMIT', () => {
    const agents = Array.from({ length: 12 }, (_, i) =>
      agent(`a${i}`, `Agent ${i}`, new Date(2025, 0, i + 1))
    )
    const result = getRecent(agents, {})
    expect(RECENT_AGENTS_LIMIT).toBe(5)
    expect(result.agents).toHaveLength(RECENT_AGENTS_LIMIT)
    expect(result.agents[0].slug).toBe('a11')
    expect(result.agents[RECENT_AGENTS_LIMIT - 1].slug).toBe(`a${12 - RECENT_AGENTS_LIMIT}`)
  })

  it('does not reorder the agents it was given', () => {
    const agents = [
      agent('old', 'Old', new Date('2025-01-01')),
      agent('new', 'New', new Date('2025-02-01')),
    ]
    getRecent(agents, {})
    expect(agents.map((a) => a.slug)).toEqual(['old', 'new'])
  })

  it('excludes agents without lastActivityAt', () => {
    const agents = [
      agent('active', 'Active', new Date('2025-03-01')),
      agent('inactive', 'Inactive'),
    ]
    expect(getRecent(agents, {}).agents.map((a) => a.slug)).toEqual(['active'])
  })

  it('returns the newest sessions across every agent, limited to RECENT_SESSIONS_LIMIT', () => {
    const a = agent('a', 'Agent A', new Date('2025-01-01'))
    const b = agent('b', 'Agent B', new Date('2025-01-02'))
    // Even days belong to a, odd days to b, so the newest alternate between them.
    const all = Array.from({ length: 14 }, (_, i) =>
      session(`s${i}`, i % 2 === 0 ? 'a' : 'b', `Session ${i}`, new Date(2025, 0, i + 1))
    )
    const result = getRecent([a, b], {
      a: all.filter((s) => s.agentSlug === 'a'),
      b: all.filter((s) => s.agentSlug === 'b'),
    })

    expect(RECENT_SESSIONS_LIMIT).toBe(10)
    expect(result.sessions.map((r) => r.session.id)).toEqual(
      ['s13', 's12', 's11', 's10', 's9', 's8', 's7', 's6', 's5', 's4']
    )
    expect(result.sessions.map((r) => r.agent.slug)).toEqual(['b', 'a', 'b', 'a', 'b', 'a', 'b', 'a', 'b', 'a'])
  })

  it('honours explicit limits', () => {
    const a = agent('a', 'Agent A', new Date('2025-01-01'))
    const b = agent('b', 'Agent B', new Date('2025-01-02'))
    const sessions = [
      session('s1', 'a', 'One', new Date('2025-01-01')),
      session('s2', 'a', 'Two', new Date('2025-01-02')),
    ]
    const result = getRecent([a, b], { a: sessions }, { agents: 1, sessions: 1 })
    expect(result.agents.map((x) => x.slug)).toEqual(['b'])
    expect(result.sessions.map((r) => r.session.id)).toEqual(['s2'])
  })

  it('never lists dashboards', () => {
    const a = agent('a', 'Agent A', new Date('2025-01-01'), [{ slug: 'overview', name: 'Overview' }])
    expect(getRecent([a], {}).dashboards).toEqual([])
  })
})

describe('flattenSections', () => {
  const alpha = agent('alpha', 'Alpha', new Date('2025-01-01'))
  const beta = agent('beta', 'Beta', new Date('2025-01-02'))
  const d1: ApiAgentDashboard = { slug: 'dash-one', name: 'Dash one' }
  const s1 = session('s1', 'alpha', 'one')
  const s2 = session('s2', 'beta', 'two')

  it('walks agents, then sessions, then dashboards', () => {
    const flat = flattenSections({
      agents: [alpha, beta],
      sessions: [{ agent: alpha, session: s1 }, { agent: beta, session: s2 }],
      dashboards: [{ agent: alpha, dashboard: d1 }],
    })
    expect(flat).toEqual([
      { kind: 'agent', agent: alpha },
      { kind: 'agent', agent: beta },
      { kind: 'session', agent: alpha, session: s1 },
      { kind: 'session', agent: beta, session: s2 },
      { kind: 'dashboard', agent: alpha, dashboard: d1 },
    ])
  })

  it('is empty when every section is', () => {
    expect(flattenSections({ agents: [], sessions: [], dashboards: [] })).toEqual([])
  })
})
