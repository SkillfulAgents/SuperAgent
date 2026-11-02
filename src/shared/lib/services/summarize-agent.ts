import { agentRegistry } from '@shared/lib/agent-actor'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import type { SessionMetadataMap } from '@shared/lib/types/agent'
import type { ApiAgentDashboard } from '@shared/lib/types/api'
import { agentSummaryOf, type AgentSummary } from './agent-summaries'
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
 * What an agent list shows of one agent, read from its actor: the summary its publisher stores.
 * `sessionMetadata` is a read the caller already started, so the metadata is read once. Live
 * state is read last, after these reads and `readLiveAfter`, so it also covers a session that
 * started meanwhile (one whose transcript is not written yet).
 */
export async function summarizeAgent(
  slug: AgentSlug,
  options: { sessionMetadata?: Promise<SessionMetadataMap>; readLiveAfter?: Promise<unknown> } = {},
): Promise<AgentSummary> {
  const actor = agentRegistry.get(slug)
  const [sessions, metadata, artifacts] = await Promise.all([
    actor.sessions.summary(),
    options.sessionMetadata ?? actor.sessions.readMetadata(),
    listArtifactsAndWidgets(slug),
    options.readLiveAfter?.catch(() => undefined),
  ])
  const live = await actor.live()
  return agentSummaryOf(live, sessions, {
    visibleSessionIds: sessions.sessionIds.filter((id) => !isHiddenAutomatedSession(metadata[id])),
    dashboards: apiDashboardsOf(artifacts.dashboards),
    widgets: await widgetRefreshService.decorate(slug, artifacts.widgets),
  })
}
