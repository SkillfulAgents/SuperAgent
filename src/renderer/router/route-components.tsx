/**
 * Placeholder route components for views not yet migrated to the router.
 *
 * In R4 the agent sub-views (session/task/webhook/chat/dashboard/api-logs/
 * connections) are still SelectionContext-driven and rendered by the agent body
 * (agentHomeRoute) — the URL stays at `/agents/$slug`, so these leaf routes are
 * never matched and render nothing. They are replaced with the real views in
 * R5–R10. Settings becomes a real route at R12.
 */
function NullRoute() {
  return null
}

export const SessionRoute = NullRoute // R9
export const TaskRoute = NullRoute // R6
export const WebhookRoute = NullRoute // R6
export const ChatRoute = NullRoute // R8
export const DashboardRoute = NullRoute // R7
export const ApiLogsRoute = NullRoute // R5
export const ConnectionsRoute = NullRoute // R5
export const SettingsRoute = NullRoute // R12
export const SettingsTabRoute = NullRoute // R12
