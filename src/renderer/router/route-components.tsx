import { useParams, useSearch } from '@tanstack/react-router'
import { ApiLogsView } from '@renderer/components/api-logs/api-logs-view'
import { ConnectionsView } from '@renderer/components/connections/connections-view'

/**
 * Leaf route components for the agent sub-views. The shared header chrome +
 * agent-level banners live in the AgentShell layout, so each leaf renders only
 * its body inside AgentShell's `<Outlet/>`.
 *
 * Views not yet migrated (session/task/webhook/chat/dashboard) stay
 * SelectionContext-driven and render through the agent body (agentHomeRoute) —
 * the URL stays at `/agents/$slug`, so these leaf routes are never matched. They
 * become real routes in R6–R10. Settings becomes a real route at R12.
 */
function NullRoute() {
  return null
}

function useAgentSlug(): string | null {
  return (useParams({ strict: false }) as { slug?: string }).slug ?? null
}

// R5 — api-logs is now a real leaf route. The agent slug is read from the URL.
export function ApiLogsRoute() {
  const slug = useAgentSlug()
  if (!slug) return null
  return <ApiLogsView agentSlug={slug} />
}

// R5 — connections is a real leaf route; the open detail overlay travels in the
// URL search (`?detail&source`), validated/coerced here exactly like the codec
// (decodeLocation): both must be present and well-formed, else fall back to list.
export function ConnectionsRoute() {
  const slug = useAgentSlug()
  const search = useSearch({ strict: false }) as { detail?: unknown; source?: unknown }
  const detailKey = typeof search.detail === 'string' ? search.detail : undefined
  const source: 'home' | 'list' | undefined =
    search.source === 'home' ? 'home' : search.source === 'list' ? 'list' : undefined
  const detail = detailKey && source ? { rowKey: detailKey, source } : null
  if (!slug) return null
  return <ConnectionsView agentSlug={slug} detail={detail} />
}

export const SessionRoute = NullRoute // R9
export const TaskRoute = NullRoute // R6
export const WebhookRoute = NullRoute // R6
export const ChatRoute = NullRoute // R8
export const DashboardRoute = NullRoute // R7
export const SettingsRoute = NullRoute // R12
export const SettingsTabRoute = NullRoute // R12
