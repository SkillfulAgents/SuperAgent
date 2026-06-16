
import { SessionChatColumn } from './session-chat-column'
import { AgentSettingsDialog } from '@renderer/components/agents/agent-settings-dialog'
import { SystemPromptDialog } from '@renderer/components/agents/system-prompt-dialog'
import { AgentHome } from '@renderer/components/agents/agent-home/agent-home'
import { ChatIntegrationView } from '@renderer/components/chat-integrations/chat-integration-view'
import { FilePreviewProvider } from '@renderer/context/file-preview-context'
import { DashboardView } from '@renderer/components/dashboards/dashboard-view'
import { ChevronLeft, CalendarClock, Zap } from 'lucide-react'
import { useState, useEffect } from 'react'
import { useAgent } from '@renderer/hooks/use-agents'
import { useSession } from '@renderer/hooks/use-sessions'
import { useParams, useNavigate } from '@tanstack/react-router'
import { useSelection } from '@renderer/context/selection-context'
import { useMarkSessionNotificationsRead } from '@renderer/hooks/use-notifications'
import { usePendingMessages } from '@renderer/context/pending-messages-context'
import { useUser } from '@renderer/context/user-context'
import { useRenderTracker } from '@renderer/lib/perf'
import { computeContextPercent } from '@shared/lib/utils/context-usage'
import { useSessionSearch } from '@renderer/hooks/use-session-search'
import { SessionSearchBar } from '@renderer/components/messages/session-search-bar'

/**
 * The agent index leaf (agentHomeRoute): the per-view body switch for the views
 * still driven by SelectionContext (home/session/task/webhook/chat/dashboard),
 * the session-scoped automated-session banners, and the agent-scoped dialogs.
 *
 * The shared header chrome + agent-level banners live in the AgentShell layout
 * (migration plan §8.1), so this renders only the body that fills AgentShell's
 * `<Outlet/>`. api-logs/connections moved to their own leaf routes in R5; the
 * remaining sub-views peel out into routes in R6–R10.
 */
export function AgentBody() {
  useRenderTracker('AgentBody')
  // Agent slug comes from the URL (authoritative). The sub-view still comes from
  // Selection until each one becomes a route (R6–R10).
  const agentSlug = (useParams({ strict: false }) as { slug?: string }).slug ?? null
  const { view, setView } = useSelection()
  const navigate = useNavigate()
  const sessionId = view.kind === 'session' ? view.id : null
  const dashboardSlug = view.kind === 'dashboard' ? view.slug : null
  const scheduledTaskId = view.kind === 'task' ? view.id : null
  const webhookTriggerId = view.kind === 'webhook' ? view.id : null
  const chatIntegrationId = view.kind === 'chat' ? view.integrationId : null
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  const [systemPromptOpen, setSystemPromptOpen] = useState(false)
  const { data: agent } = useAgent(agentSlug)
  const { data: session } = useSession(sessionId, agentSlug)
  const markSessionNotificationsRead = useMarkSessionNotificationsRead()
  const {
    getPendingMessages,
    onMessageSent,
    onMessageUuidAssigned,
    onPendingMessageAppeared,
    onSessionCreated,
    streamContextUsage,
  } = usePendingMessages()
  const { canUseAgent } = useUser()
  const isViewOnly = agentSlug ? !canUseAgent(agentSlug) : false
  const isSessionView = !!(
    agentSlug &&
    sessionId &&
    !dashboardSlug &&
    !scheduledTaskId &&
    !webhookTriggerId &&
    !chatIntegrationId
  )
  const search = useSessionSearch(isSessionView, sessionId ?? null)

  // Context usage: prefer live stream data, fall back to persisted session metadata
  const contextUsage = streamContextUsage ?? session?.lastUsage ?? null
  const contextPercent = contextUsage ? computeContextPercent(contextUsage) : null

  // Auto-mark notifications as read when viewing a session
  useEffect(() => {
    if (sessionId) {
      // Small delay to avoid marking as read on quick navigation
      const timeout = setTimeout(() => {
        markSessionNotificationsRead.mutate(sessionId)
      }, 1000)
      return () => clearTimeout(timeout)
    }
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Also mark notifications as read when tab regains focus while viewing a session
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && sessionId) {
        // Mark notifications as read when user returns to this tab
        markSessionNotificationsRead.mutate(sessionId)
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Defensive: AgentBody only renders under the agent route, so the slug is set
  // (the bridge mirrors it from the URL). Bail rather than render a broken shell.
  if (!agentSlug) return null

  return (
    <>
      {/* Automated session indicator — links back to the parent trigger/schedule */}
      {sessionId && session?.scheduledTaskId && (
        <div className="shrink-0 border-b bg-background px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <button
              onClick={() => {
                const taskId = session.scheduledTaskId!
                setView({ kind: 'task', id: taskId })
                void navigate({ to: '/agents/$slug/tasks/$taskId', params: { slug: agentSlug, taskId } })
              }}
              className="inline-flex items-center gap-1 text-primary hover:underline shrink-0"
            >
              <ChevronLeft className="h-3 w-3" />
              View schedule
            </button>
            <span className="mx-1 text-border">|</span>
            <CalendarClock className="h-3 w-3 shrink-0" />
            <span>
              Session created by scheduled job{session.scheduledTaskName ? ` "${session.scheduledTaskName}"` : ''}
            </span>
          </div>
        </div>
      )}
      {sessionId && session?.webhookTriggerId && (
        <div className="shrink-0 border-b bg-background px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <button
              onClick={() => {
                const webhookId = session.webhookTriggerId!
                setView({ kind: 'webhook', id: webhookId })
                void navigate({ to: '/agents/$slug/webhooks/$webhookId', params: { slug: agentSlug, webhookId } })
              }}
              className="inline-flex items-center gap-1 text-primary hover:underline shrink-0"
            >
              <ChevronLeft className="h-3 w-3" />
              View trigger
            </button>
            <span className="mx-1 text-border">|</span>
            <Zap className="h-3 w-3 shrink-0" />
            <span>
              Session created by webhook trigger{session.webhookTriggerName ? ` "${session.webhookTriggerName}"` : ''}
            </span>
          </div>
        </div>
      )}

      {view.kind === 'dashboard' ? (
        <DashboardView agentSlug={agentSlug} dashboardSlug={view.slug} />
      ) : view.kind === 'chat' ? (
        <ChatIntegrationView integrationId={view.integrationId} agentSlug={agentSlug} />
      ) : view.kind === 'session' ? (
        <FilePreviewProvider>
          <div className="flex-1 flex flex-col min-h-0">
            <SessionSearchBar search={search} />
            <SessionChatColumn
              sessionId={view.id}
              agentSlug={agentSlug}
              pendingUserMessages={getPendingMessages(view.id)}
              isViewOnly={isViewOnly}
              contextPercent={contextPercent}
              effort={session?.effort}
              model={session?.model}
              onPendingMessageAppeared={onPendingMessageAppeared}
              onMessageSent={onMessageSent}
              onMessageUuidAssigned={onMessageUuidAssigned}
              onMessageFailed={onPendingMessageAppeared}
            />
          </div>
        </FilePreviewProvider>
      ) : view.kind === 'home' ? (
        /* Show home page with large input when no session is selected */
        agent && (
          <AgentHome
            key={agent.slug}
            agent={agent}
            onSessionCreated={onSessionCreated}
            onOpenSettings={(tab?: string) => {
              if (tab === 'system-prompt') {
                setSystemPromptOpen(true)
                return
              }
              setSettingsTab(tab)
              setSettingsOpen(true)
            }}
          />
        )
      ) : (
        /* apiLogs/connections (R5) and task/webhook (R6) render via their own
           leaf routes; this branch is only hit transiently before the route
           transition lands. */
        null
      )}

      {agent && (
        <>
          <AgentSettingsDialog
            agent={agent}
            open={settingsOpen}
            onOpenChange={(open) => { setSettingsOpen(open); if (!open) setSettingsTab(undefined) }}
            initialTab={settingsTab}
          />
          <SystemPromptDialog
            agent={agent}
            open={systemPromptOpen}
            onOpenChange={setSystemPromptOpen}
          />
        </>
      )}
    </>
  )
}

if (__RENDER_TRACKING__) {
  (AgentBody as any).whyDidYouRender = true
}
