import type { ApiAgentDashboard, ApiSession } from '@shared/lib/types/api'
import type { ApiAgent } from '@renderer/hooks/use-agents'

export interface AgentGroup {
  agent: ApiAgent
  matchedAgent: boolean
  dashboards: ApiAgentDashboard[]
  sessions: ApiSession[]
}

export type FlatItem =
  | { kind: 'agent'; agent: ApiAgent }
  | { kind: 'dashboard'; agent: ApiAgent; dashboard: ApiAgentDashboard }
  | { kind: 'session'; agent: ApiAgent; session: ApiSession }

function getAgentDashboards(agent: ApiAgent): ApiAgentDashboard[] {
  if (Array.isArray(agent.dashboards)) return agent.dashboards

  const slugs = agent.dashboardSlugs ?? []
  const names = agent.dashboardNames ?? []
  return slugs.map((slug, index) => ({
    slug,
    name: names[index] || slug,
  }))
}

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
      return { agent, matchedAgent: true, dashboards: getAgentDashboards(agent), sessions }
    })
}

/**
 * Filter agents, dashboards, and sessions by a substring query. Case-insensitive.
 *
 * - An agent is included if its name matches OR if any of its dashboards/sessions match.
 * - Only matching dashboards/sessions are returned within an agent group.
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
    const dashboards = getAgentDashboards(agent)
    const matchedAgent = agent.name.toLowerCase().includes(trimmed)
    const matchedDashboards = dashboards.filter((d) =>
      d.name.toLowerCase().includes(trimmed) || d.slug.toLowerCase().includes(trimmed)
    )
    const matchedSessions = sessions.filter((s) =>
      s.name.toLowerCase().includes(trimmed)
    )
    return { agent, matchedAgent, dashboards: matchedDashboards, sessions: matchedSessions }
  })
  return groups.filter((g) => g.matchedAgent || g.dashboards.length > 0 || g.sessions.length > 0)
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
      for (const d of g.dashboards) {
        items.push({ kind: 'dashboard', agent: g.agent, dashboard: d })
      }
      for (const s of g.sessions) {
        items.push({ kind: 'session', agent: g.agent, session: s })
      }
    }
  }
  return items
}
