import { describe, it, expect } from 'vitest'
import { filterAgentsAndSessions, flattenGroups } from './filter'
import type { ApiAgent, ApiSession } from '@shared/lib/types/api'

function agent(slug: string, name: string): ApiAgent {
  return {
    slug,
    name,
    createdAt: new Date(0),
    status: 'stopped',
    containerPort: null,
  }
}

function session(id: string, agentSlug: string, name: string): ApiSession {
  return {
    id,
    agentSlug,
    name,
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
    messageCount: 0,
    isActive: false,
    isAwaitingInput: false,
    hasUnreadNotifications: false,
  } as ApiSession
}

describe('filterAgentsAndSessions', () => {
  const alpha = agent('alpha', 'Alpha Bot')
  const beta = agent('beta', 'Beta Worker')
  const sessions = {
    alpha: [session('s1', 'alpha', 'Refactor login'), session('s2', 'alpha', 'Database backup')],
    beta: [session('s3', 'beta', 'Login analytics'), session('s4', 'beta', 'Daily report')],
  }

  it('empty query returns every agent with no nested sessions', () => {
    const groups = filterAgentsAndSessions([alpha, beta], sessions, '')
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({ agent: alpha, matchedAgent: true, sessions: [] })
    expect(groups[1]).toEqual({ agent: beta, matchedAgent: true, sessions: [] })
  })

  it('matches agent name case-insensitively', () => {
    const groups = filterAgentsAndSessions([alpha, beta], sessions, 'ALPHA')
    expect(groups).toHaveLength(1)
    expect(groups[0].agent.slug).toBe('alpha')
    expect(groups[0].matchedAgent).toBe(true)
    expect(groups[0].sessions).toEqual([])
  })

  it('surfaces a non-matching agent because one of its sessions matches', () => {
    const groups = filterAgentsAndSessions([alpha, beta], sessions, 'login')
    // Both agents appear: alpha has "Refactor login", beta has "Login analytics"
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
    // None of alpha's sessions contain "alpha"
    expect(groups[0].sessions).toEqual([])
  })

  it('hides agents with no name match and no session match', () => {
    const groups = filterAgentsAndSessions([alpha, beta], sessions, 'zzz')
    expect(groups).toHaveLength(0)
  })

  it('whitespace-only query is treated as empty', () => {
    const groups = filterAgentsAndSessions([alpha, beta], sessions, '   ')
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.matchedAgent && g.sessions.length === 0)).toBe(true)
  })
})

describe('flattenGroups', () => {
  const alpha = agent('alpha', 'Alpha')
  const s1 = session('s1', 'alpha', 'one')
  const s2 = session('s2', 'alpha', 'two')

  it('emits agent first, then its sessions in order', () => {
    const flat = flattenGroups([{ agent: alpha, matchedAgent: true, sessions: [s1, s2] }])
    expect(flat).toEqual([
      { kind: 'agent', agent: alpha },
      { kind: 'session', agent: alpha, session: s1 },
      { kind: 'session', agent: alpha, session: s2 },
    ])
  })

  it('emits an agent header even when it has no sessions', () => {
    const flat = flattenGroups([{ agent: alpha, matchedAgent: true, sessions: [] }])
    expect(flat).toEqual([{ kind: 'agent', agent: alpha }])
  })
})
