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
 * Filter agents and sessions by a substring query. Case-insensitive.
 *
 * - Empty query returns every agent with `matchedAgent: true` and no sessions.
 * - An agent is included if its name matches OR if any of its sessions match.
 * - Only matching sessions are returned within an agent group.
 */
export function filterAgentsAndSessions(
  agents: ApiAgent[],
  sessionsByAgent: Record<string, ApiSession[]>,
  query: string
): AgentGroup[] {
  const trimmed = query.trim().toLowerCase()
  const groups = agents.map<AgentGroup>((agent) => {
    const sessions = sessionsByAgent[agent.slug] ?? []
    if (!trimmed) {
      return { agent, matchedAgent: true, sessions: [] }
    }
    const matchedAgent = agent.name.toLowerCase().includes(trimmed)
    const matchedSessions = sessions.filter((s) =>
      s.name.toLowerCase().includes(trimmed)
    )
    return { agent, matchedAgent, sessions: matchedSessions }
  })
  if (!trimmed) return groups
  return groups.filter((g) => g.matchedAgent || g.sessions.length > 0)
}

/** Flatten visible groups into the linear list used for keyboard navigation. */
export function flattenGroups(groups: AgentGroup[]): FlatItem[] {
  const items: FlatItem[] = []
  for (const g of groups) {
    items.push({ kind: 'agent', agent: g.agent })
    for (const s of g.sessions) {
      items.push({ kind: 'session', agent: g.agent, session: s })
    }
  }
  return items
}
