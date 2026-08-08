import type { QueryClient } from '@tanstack/react-query'
import type { ApiAgent } from '@shared/lib/types/api'

function matchesAgent(agent: ApiAgent, slug: string): boolean {
  return agent.slug === slug || agent.displaySlug === slug
}

function updateMatchingAgents(
  queryClient: QueryClient,
  slug: string,
  update: (agent: ApiAgent) => ApiAgent,
): void {
  queryClient.setQueryData<ApiAgent[]>(['agents'], (agents) => (
    agents?.map((agent) => matchesAgent(agent, slug) ? update(agent) : agent)
  ))
  queryClient.setQueriesData<ApiAgent>(
    {
      predicate: (query) => query.queryKey[0] === 'agents' && query.queryKey.length === 2,
    },
    (agent) => agent && matchesAgent(agent, slug) ? update(agent) : agent,
  )
}

/** Apply a pushed/command runtime transition without refetching agent summaries. */
export function updateAgentRuntimeCache(
  queryClient: QueryClient,
  slug: string,
  status: ApiAgent['status'],
  containerPort?: number | null,
): void {
  updateMatchingAgents(queryClient, slug, (agent) => ({
    ...agent,
    status,
    containerPort: status === 'stopped'
      ? null
      : containerPort === undefined
        ? agent.containerPort
        : containerPort,
  }))
}

/** Invalidate artifact queries for one agent, including decorative route aliases. */
export function invalidateAgentArtifacts(queryClient: QueryClient, slug: string): void {
  const aliases = new Set([slug])
  const addAliases = (agent: ApiAgent | undefined) => {
    if (!agent || !matchesAgent(agent, slug)) return
    aliases.add(agent.slug)
    aliases.add(agent.displaySlug)
  }
  queryClient.getQueryData<ApiAgent[]>(['agents'])?.forEach(addAliases)
  for (const [, agent] of queryClient.getQueriesData<ApiAgent>({
    predicate: (query) => query.queryKey[0] === 'agents' && query.queryKey.length === 2,
  })) {
    addAliases(agent)
  }

  queryClient.invalidateQueries({
    predicate: (query) => (
      query.queryKey[0] === 'artifacts'
      && typeof query.queryKey[1] === 'string'
      && aliases.has(query.queryKey[1])
    ),
  })
}

/** Mark one dashboard thumbnail ready in every cached projection of its agent. */
export function markDashboardScreenshotReady(
  queryClient: QueryClient,
  agentSlug: string,
  dashboardSlug: string,
): void {
  updateMatchingAgents(queryClient, agentSlug, (agent) => {
    if (!agent.dashboards?.some((dashboard) => dashboard.slug === dashboardSlug)) return agent
    return {
      ...agent,
      dashboards: agent.dashboards.map((dashboard) => (
        dashboard.slug === dashboardSlug
          ? { ...dashboard, hasScreenshot: true }
          : dashboard
      )),
    }
  })
}
