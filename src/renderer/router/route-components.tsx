import { Outlet, useParams, useSearch } from '@tanstack/react-router'
import { ApiLogsView } from '@renderer/components/api-logs/api-logs-view'
import { ConnectionsView } from '@renderer/components/connections/connections-view'
import { ScheduledTaskView } from '@renderer/components/scheduled-tasks/scheduled-task-view'
import { WebhookTriggerView } from '@renderer/components/webhook-triggers/webhook-trigger-view'
import { DashboardView } from '@renderer/components/dashboards/dashboard-view'
import { ChatIntegrationView } from '@renderer/components/chat-integrations/chat-integration-view'
import { SessionView } from '@renderer/components/layout/session-view'
import { AgentHome } from '@renderer/components/agents/agent-home/agent-home'
import { useAgent } from '@renderer/hooks/use-agents'
import { usePendingMessages } from '@renderer/context/pending-messages-context'
import { GlobalSettingsPage } from '@renderer/components/settings/global-settings-page'
import { useDialogs } from '@renderer/context/dialog-context'

/**
 * Leaf route components for the agent sub-views. The shared header chrome +
 * agent-level banners live in the AgentShell layout, so each leaf renders only
 * its body inside AgentShell's `<Outlet/>`.
 *
 * Every agent sub-view is a real leaf route now: home (R10),
 * api-logs/connections (R5), task/webhook (R6), dashboard (R7), chat (R8),
 * session (R9) and settings (R12) are all real routes now.
 */
function useAgentSlug(): string | null {
  return (useParams({ strict: false }) as { slug?: string }).slug ?? null
}

// R10 — the agent `home` index leaf. AgentHome owns its own agent-scoped dialogs
// (§6.6) and the new-agent morph (via NavTransientContext); this wrapper just
// resolves the agent + the optimistic-message creator from context. `key` on the
// slug remounts AgentHome per agent so the morph's first-mount read fires (§8.5).
export function AgentHomeRoute() {
  const slug = useAgentSlug()
  const { data: agent } = useAgent(slug)
  const { onSessionCreated } = usePendingMessages()
  if (!slug || !agent) return null
  return <AgentHome key={agent.slug} agent={agent} onSessionCreated={onSessionCreated} />
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

// R6 — task / webhook are real leaf routes; ids + slug come from the URL.
export function TaskRoute() {
  const slug = useAgentSlug()
  const { taskId } = useParams({ strict: false }) as { taskId?: string }
  if (!slug || !taskId) return null
  return <ScheduledTaskView taskId={taskId} agentSlug={slug} />
}

export function WebhookRoute() {
  const slug = useAgentSlug()
  const { webhookId } = useParams({ strict: false }) as { webhookId?: string }
  if (!slug || !webhookId) return null
  return <WebhookTriggerView triggerId={webhookId} agentSlug={slug} />
}

// R7 — dashboard is a real leaf route; dashSlug + slug come from the URL.
export function DashboardRoute() {
  const slug = useAgentSlug()
  const { dashSlug } = useParams({ strict: false }) as { dashSlug?: string }
  if (!slug || !dashSlug) return null
  return <DashboardView agentSlug={slug} dashboardSlug={dashSlug} />
}

// R8 — chat is a real leaf route; integrationId is a path param and the optional
// active sub-session travels in the URL search (`?session=`).
export function ChatRoute() {
  const slug = useAgentSlug()
  const { integrationId } = useParams({ strict: false }) as { integrationId?: string }
  const search = useSearch({ strict: false }) as { session?: unknown }
  const chatSessionId = typeof search.session === 'string' ? search.session : null
  if (!slug || !integrationId) return null
  return <ChatIntegrationView integrationId={integrationId} agentSlug={slug} chatSessionId={chatSessionId} />
}

// R9 — session is a real leaf route; sessionId + slug come from the URL. The
// session body lives in SessionView (next to the other layout components) since
// it's substantial; this wrapper only resolves the params.
export function SessionRoute() {
  const slug = useAgentSlug()
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string }
  if (!slug || !sessionId) return null
  return <SessionView agentSlug={slug} sessionId={sessionId} />
}

// R12 — global settings is a top-level route now (`/settings`, `/settings/$tab`,
// sibling of the app shell, so it replaces the whole shell — same as the old
// boolean). Close pushes back to the captured `?from=` origin via DialogContext.
// settingsRoute is a LAYOUT (just an <Outlet/>) so the `$tab` child actually
// renders; the index route handles `/settings` (no tab).
function SettingsPageView({ tab }: { tab?: string }) {
  const { closeSettings, openWizard } = useDialogs()
  return <GlobalSettingsPage onClose={closeSettings} onOpenWizard={openWizard} initialSection={tab} />
}

export function SettingsLayout() {
  return <Outlet />
}

export function SettingsIndexRoute() {
  return <SettingsPageView />
}

export function SettingsTabRoute() {
  const { tab } = useParams({ strict: false }) as { tab?: string }
  return <SettingsPageView tab={tab} />
}
