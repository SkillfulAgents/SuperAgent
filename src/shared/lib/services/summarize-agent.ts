/**
 * An agent's summary, read from its actor: what `agent-summaries.ts` stores.
 * Kept apart from the storage so the storage does not pull the actor registry
 * and the artifact scan into everything that reads a stored summary.
 */
import { agentRegistry } from '@shared/lib/agent-actor'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import type { ApiAgentDashboard } from '@shared/lib/types/api'
import { agentSummaryOf, nextSummaryRevision, storeAgentSummary, type AgentSummary } from './agent-summaries'
import { listArtifactsAndWidgets } from './artifact-service'
import { isHiddenAutomatedSession } from './session-visibility'
import { widgetRefreshService } from './widget-refresh-service'

/** An agent's dashboards as an agent list shows them. */
export function apiDashboardsOf(dashboards: ReadonlyArray<{ slug: string; name?: string; hasScreenshot?: boolean }>): ApiAgentDashboard[] {
  return dashboards.map((dashboard) => ({
    slug: dashboard.slug,
    name: dashboard.name || dashboard.slug,
    ...(dashboard.hasScreenshot ? { hasScreenshot: true } : {}),
  }))
}

/**
 * Live state is read last, after the session and artifact reads, so it also
 * covers a session that started meanwhile (one whose transcript is not
 * written yet).
 */
export async function summarizeAgent(slug: AgentSlug): Promise<AgentSummary> {
  const actor = agentRegistry.get(slug)
  const [sessions, artifacts] = await Promise.all([actor.sessions.summary(), listArtifactsAndWidgets(slug)])
  const live = await actor.live()
  return agentSummaryOf(live, sessions, {
    visibleSessionIds: sessions.sessionIds.filter((id) => !isHiddenAutomatedSession(sessions.metadata[id])),
    dashboards: apiDashboardsOf(artifacts.dashboards),
    widgets: await widgetRefreshService.decorate(slug, artifacts.widgets),
  })
}

/** Ask the agent and store what it answers: the repair for an agent with no stored summary. */
export async function summarizeAndStoreAgent(slug: AgentSlug): Promise<AgentSummary> {
  // Taken before the agent is asked: an event raised meanwhile stores a later one, which this must not replace.
  const revision = nextSummaryRevision()
  const summary = await summarizeAgent(slug)
  await storeAgentSummary(slug, summary, revision)
  return summary
}
