import type { ApiSession } from '@shared/lib/types/api'
import type { ApiAgent } from '@renderer/hooks/use-agents'

export interface AgentGroup {
  agent: ApiAgent
  matchedAgent: boolean
  sessions: ApiSession[]
}

export type FlatItem =
  | { kind: 'agent'; agent: ApiAgent }
  | { kind: 'session'; agent: ApiAgent; session: ApiSession }

/**
 * Return the top N most recently used agents with their sessions sorted by recency.
 */
export function getRecentAgents(
  agents: ApiAgent[],
  sessionsByAgent: Record<string, ApiSession[]>,
  limit = 10
): AgentGroup[] {
  return [...agents]
    .filter((a) => a.lastActivityAt)
    .sort((a, b) => {
      const ta = new Date(a.lastActivityAt!).getTime()
      const tb = new Date(b.lastActivityAt!).getTime()
      return tb - ta
    })
    .slice(0, limit)
    .map((agent) => {
      const sessions = (sessionsByAgent[agent.slug] ?? [])
        .slice()
        .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())
        .slice(0, 10)
      return { agent, matchedAgent: true, sessions }
    })
}

/**
 * Filter agents and sessions by a substring query. Case-insensitive.
 *
 * - An agent is included if its name matches OR if any of its sessions match.
 * - Only matching sessions are returned within an agent group.
 */
export function filterAgentsAndSessions(
  agents: ApiAgent[],
  sessionsByAgent: Record<string, ApiSession[]>,
  query: string
): AgentGroup[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return []
  const groups = agents.map<AgentGroup>((agent) => {
    const sessions = sessionsByAgent[agent.slug] ?? []
    const matchedAgent = agent.name.toLowerCase().includes(trimmed)
    const matchedSessions = sessions.filter((s) =>
      s.name.toLowerCase().includes(trimmed)
    )
    return { agent, matchedAgent, sessions: matchedSessions }
  })
  return groups.filter((g) => g.matchedAgent || g.sessions.length > 0)
}

/** Flatten visible groups into the linear list used for keyboard navigation. */
export function flattenGroups(
  groups: AgentGroup[],
  expandedSlugs?: Set<string>
): FlatItem[] {
  const items: FlatItem[] = []
  for (const g of groups) {
    items.push({ kind: 'agent', agent: g.agent })
    if (!expandedSlugs || expandedSlugs.has(g.agent.slug)) {
      for (const s of g.sessions) {
        items.push({ kind: 'session', agent: g.agent, session: s })
      }
    }
  }
  return items
}
