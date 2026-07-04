import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router'
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
 */
function useAgentSlug(): string | null {
  return (useParams({ strict: false }) as { slug?: string }).slug ?? null
}

// The agent `home` index leaf. AgentHome owns its own agent-scoped dialogs and
// the new-agent morph (via NavTransientContext); this wrapper just resolves the
// agent + the optimistic-message creator from context. `key` on the slug remounts
// AgentHome per agent so the morph's first-mount read fires.
export function AgentHomeRoute() {
  const slug = useAgentSlug()
  const { data: agent } = useAgent(slug)
  const { onSessionCreated } = usePendingMessages()
  if (!slug || !agent) return null
  return <AgentHome key={agent.slug} agent={agent} onSessionCreated={onSessionCreated} />
}

// api-logs route: the agent slug is read from the URL.
export function ApiLogsRoute() {
  const slug = useAgentSlug()
  if (!slug) return null
  return <ApiLogsView agentSlug={slug} />
}

// The open detail overlay travels in the URL search (`?detail&source`),
// validated/coerced here exactly like the codec (decodeLocation): both must be
// present and well-formed, else fall back to list.
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

// task / webhook routes: ids + slug come from the URL.
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

// dashboard route: dashSlug + slug come from the URL.
export function DashboardRoute() {
  const slug = useAgentSlug()
  const { dashSlug } = useParams({ strict: false }) as { dashSlug?: string }
  if (!slug || !dashSlug) return null
  return <DashboardView agentSlug={slug} dashboardSlug={dashSlug} />
}

// integrationId is a path param and the optional active sub-session travels in
// the URL search (`?session=`).
export function ChatRoute() {
  const slug = useAgentSlug()
  const { integrationId } = useParams({ strict: false }) as { integrationId?: string }
  const search = useSearch({ strict: false }) as { session?: unknown; newchat?: unknown }
  const chatSessionId = typeof search.session === 'string' ? search.session : null
  const chatNewConvId = typeof search.newchat === 'string' ? search.newchat : null
  if (!slug || !integrationId) return null
  return (
    <ChatIntegrationView
      integrationId={integrationId}
      agentSlug={slug}
      chatSessionId={chatSessionId}
      chatNewConvId={chatNewConvId}
    />
  )
}

// sessionId + slug come from the URL. The session body lives in SessionView
// (next to the other layout components) since it's substantial; this wrapper
// only resolves the params.
export function SessionRoute() {
  const slug = useAgentSlug()
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string }
  if (!slug || !sessionId) return null
  return <SessionView agentSlug={slug} sessionId={sessionId} />
}

// Global settings is a top-level route (`/settings`, `/settings/$tab`), sibling
// of the app shell, so it replaces the whole shell. Close pushes back to the
// captured `?from=` origin via DialogContext. settingsRoute is a LAYOUT (just an
// <Outlet/>) so the `$tab` child actually renders; the index route handles
// `/settings` (no tab).
function SettingsPageView({ tab }: { tab?: string }) {
  const { closeSettings, openWizard } = useDialogs()
  const navigate = useNavigate()
  return (
    <GlobalSettingsPage
      onClose={closeSettings}
      onOpenWizard={openWizard}
      initialSection={tab}
      // Switching tabs drives the URL → /settings/$tab, preserving `?from=` so
      // the close-target survives a tab switch. The nav items render as real
      // <a href> links to this target so cmd/middle-click opens a tab in a new
      // window (web); a plain click navigates in place.
      sectionLinkProps={(id) => ({ to: '/settings/$tab', params: { tab: id }, search: (prev) => prev })}
      onSectionChange={(id) => navigate({ to: '/settings/$tab', params: { tab: id }, search: (prev) => prev })}
    />
  )
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
