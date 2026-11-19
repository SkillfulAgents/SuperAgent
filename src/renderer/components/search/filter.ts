import type { ApiAgentDashboard, ApiSession } from '@shared/lib/types/api'
import type { ApiAgent } from '@renderer/hooks/use-agents'

export interface DashboardResult {
  agent: ApiAgent
  dashboard: ApiAgentDashboard
}

export interface SessionResult {
  agent: ApiAgent
  session: ApiSession
}

/**
 * What the search dialog lists, one array per section. A section with nothing
 * in it is not drawn.
 */
export interface SearchSections {
  agents: ApiAgent[]
  sessions: SessionResult[]
  dashboards: DashboardResult[]
}

export type FlatItem =
  | { kind: 'agent'; agent: ApiAgent }
  | { kind: 'dashboard'; agent: ApiAgent; dashboard: ApiAgentDashboard }
  | { kind: 'session'; agent: ApiAgent; session: ApiSession }

/** How many rows "Recent agents" and "Recent sessions" show before a query is typed. */
export const RECENT_AGENTS_LIMIT = 5
export const RECENT_SESSIONS_LIMIT = 10

function getAgentDashboards(agent: ApiAgent): ApiAgentDashboard[] {
  return Array.isArray(agent.dashboards) ? agent.dashboards : []
}

function time(date: Date | string | null | undefined): number {
  return date ? new Date(date).getTime() : 0
}

function byRecentSession(a: SessionResult, b: SessionResult): number {
  return time(b.session.lastActivityAt) - time(a.session.lastActivityAt)
}

/**
 * What the dialog shows before anything is typed: the most recently active
 * agents, and the most recently active sessions across every agent.
 */
export function getRecent(
  agents: ApiAgent[],
  sessionsByAgent: Record<string, ApiSession[]>,
  limits: { agents: number; sessions: number } = { agents: RECENT_AGENTS_LIMIT, sessions: RECENT_SESSIONS_LIMIT }
): SearchSections {
  const recentAgents = agents
    .filter((a) => a.lastActivityAt)
    .sort((a, b) => time(b.lastActivityAt) - time(a.lastActivityAt))
    .slice(0, limits.agents)
  const recentSessions = agents
    .flatMap((agent) => (sessionsByAgent[agent.slug] ?? []).map((session) => ({ agent, session })))
    .sort(byRecentSession)
    .slice(0, limits.sessions)
  return { agents: recentAgents, sessions: recentSessions, dashboards: [] }
}

/**
 * Filter agents, sessions, and dashboards by a substring query. Case-insensitive.
 *
 * Each kind is matched on its own name: an agent whose name does not match is
 * not listed because one of its sessions does. Sessions come newest first.
 */
export function searchAll(
  agents: ApiAgent[],
  sessionsByAgent: Record<string, ApiSession[]>,
  query: string
): SearchSections {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return { agents: [], sessions: [], dashboards: [] }
  const matches = (text: string) => text.toLowerCase().includes(trimmed)
  return {
    agents: agents.filter((agent) => matches(agent.name)),
    sessions: agents
      .flatMap((agent) =>
        (sessionsByAgent[agent.slug] ?? [])
          .filter((s) => matches(s.name))
          .map((session) => ({ agent, session }))
      )
      .sort(byRecentSession),
    dashboards: agents.flatMap((agent) =>
      getAgentDashboards(agent)
        .filter((d) => matches(d.name) || matches(d.slug))
        .map((dashboard) => ({ agent, dashboard }))
    ),
  }
}

/** The sections in the order they are drawn, as the linear list keyboard navigation walks. */
export function flattenSections(sections: SearchSections): FlatItem[] {
  return [
    ...sections.agents.map<FlatItem>((agent) => ({ kind: 'agent', agent })),
    ...sections.sessions.map<FlatItem>(({ agent, session }) => ({ kind: 'session', agent, session })),
    ...sections.dashboards.map<FlatItem>(({ agent, dashboard }) => ({ kind: 'dashboard', agent, dashboard })),
  ]
}
