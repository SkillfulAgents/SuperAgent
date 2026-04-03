
import { MessageList } from '@renderer/components/messages/message-list'
import { MessageInput } from '@renderer/components/messages/message-input'
import { AgentActivityIndicator } from '@renderer/components/messages/agent-activity-indicator'
import { AgentSettingsDialog } from '@renderer/components/agents/agent-settings-dialog'
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { AgentLanding } from '@renderer/components/agents/agent-landing'
import { HomePage } from '@renderer/components/home/home-page'
import { ScheduledTaskView } from '@renderer/components/scheduled-tasks/scheduled-task-view'
import { WebhookTriggerView } from '@renderer/components/webhook-triggers/webhook-trigger-view'
import { BrowserDrawerPanel } from '@renderer/components/browser/browser-drawer-panel'
import { DashboardView } from '@renderer/components/dashboards/dashboard-view'
import { Button } from '@renderer/components/ui/button'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { DonutChart } from '@renderer/components/ui/donut-chart'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { Plus, Play, Square, ChevronRight, ChevronLeft, Settings, Clock, Loader2, AlertCircle, AlertTriangle, X, CalendarClock, Webhook } from 'lucide-react'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useAgent, useStartAgent, useStopAgent } from '@renderer/hooks/use-agents'
import { useSessions, useSession } from '@renderer/hooks/use-sessions'
import { useScheduledTask } from '@renderer/hooks/use-scheduled-tasks'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { useSelection } from '@renderer/context/selection-context'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { useMarkSessionNotificationsRead } from '@renderer/hooks/use-notifications'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useUser } from '@renderer/context/user-context'
import { useMountWarnings } from '@renderer/hooks/use-mount-warnings'
import { useRenderTracker } from '@renderer/lib/perf'
import { computeContextPercent } from '@shared/lib/utils/context-usage'

export function MainContent() {
  useRenderTracker('MainContent')
  const {
    selectedAgentSlug: agentSlug,
    selectedSessionId: sessionId,
    selectedScheduledTaskId: scheduledTaskId,
    selectedWebhookTriggerId: webhookTriggerId,
    selectedDashboardSlug: dashboardSlug,
    selectSession,
    selectScheduledTask,
    selectWebhookTrigger,
  } = useSelection()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [contextBarExpanded, setContextBarExpanded] = useState(false)
  // Pending user messages per session — survives navigation between sessions
  const pendingMessagesRef = useRef(new Map<string, { text: string; sentAt: number; sender?: { id: string; name: string; email: string } }>())
  const [, forceUpdate] = useState(0)
  const { data: agent } = useAgent(agentSlug)
  const { data: sessions } = useSessions(agentSlug)
  const { data: session } = useSession(sessionId, agentSlug)
  const { data: scheduledTask } = useScheduledTask(scheduledTaskId)
  const startAgent = useStartAgent()
  const stopAgent = useStopAgent()
  const hasActiveSessions = sessions?.some((s) => s.isActive) ?? false
  const hasSessionsAwaitingInput = sessions?.some((s) => s.isAwaitingInput) ?? false
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const markSessionNotificationsRead = useMarkSessionNotificationsRead()
  const { browserActive, isActive, contextUsage: streamContextUsage } = useMessageStream(sessionId ?? null, agentSlug ?? null)
  const { canUseAgent, user, isAuthMode } = useUser()
  const isViewOnly = agentSlug ? !canUseAgent(agentSlug) : false
  const { warning: mountWarning, dismiss: dismissMountWarning } = useMountWarnings(agentSlug ?? null)
  const { data: runtimeStatus, isPending: isRuntimePending } = useRuntimeStatus()
  const readiness = runtimeStatus?.runtimeReadiness
  const isRuntimeReady = isRuntimePending || readiness?.status === 'READY'
  const isPulling = readiness?.status === 'PULLING_IMAGE'
  const apiKeyConfigured = runtimeStatus?.apiKeyConfigured !== false

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

  // Add left padding for macOS traffic lights when sidebar is collapsed in Electron (not in full screen)
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  const pendingUserMessage = sessionId ? (pendingMessagesRef.current.get(sessionId) ?? null) : null

  const handleMessageSent = useCallback((content: string) => {
    if (sessionId) {
      pendingMessagesRef.current.set(sessionId, {
        text: content,
        sentAt: Date.now(),
        sender: isAuthMode && user ? { id: user.id, name: user.name, email: user.email } : undefined,
      })
      forceUpdate((n) => n + 1)
    }
  }, [sessionId, isAuthMode, user])

  const handlePendingMessageAppeared = useCallback(() => {
    if (sessionId) {
      pendingMessagesRef.current.delete(sessionId)
      forceUpdate((n) => n + 1)
    }
  }, [sessionId])

  // Callback for AgentLanding when a new session is created with initial message
  const handleSessionCreated = useCallback((newSessionId: string, initialMessage: string) => {
    pendingMessagesRef.current.set(newSessionId, {
      text: initialMessage,
      sentAt: Date.now(),
      sender: isAuthMode && user ? { id: user.id, name: user.name, email: user.email } : undefined,
    })
    selectSession(newSessionId)
  }, [selectSession, isAuthMode, user])

  if (!agentSlug) {
    return <HomePage />
  }

  return (
    <div className="h-full flex flex-col" data-testid="main-content">
      {/* Fixed header - draggable region for Electron */}
      <header
        className={`shrink-0 flex min-h-12 py-1.5 md:py-0 md:h-12 items-center gap-2 border-b bg-background pl-4 pr-2 ${isElectron() ? 'app-drag-region' : ''}`}
      >
        <SidebarTrigger
          className={`app-no-drag ${needsTrafficLightPadding ? 'ml-16' : '-ml-1'}`}
        />
        <div className="flex flex-col md:flex-row md:items-center gap-0 md:gap-2 min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm md:text-base font-semibold truncate">{agent?.name || 'Loading...'}</span>
            {agent && <AgentStatus status={agent.status} hasActiveSessions={hasActiveSessions} hasSessionsAwaitingInput={hasSessionsAwaitingInput} />}
          </div>
          {sessionId && session?.agentSlug === agentSlug && (
            <div className="flex items-center gap-2 min-w-0">
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 hidden md:block" />
              <SessionContextMenu
                sessionId={sessionId}
                sessionName={session?.name || 'Session'}
                agentSlug={agentSlug}
              >
                <span className="text-xs md:text-sm text-muted-foreground truncate cursor-context-menu app-no-drag">
                  {session?.name || 'Loading...'}
                </span>
              </SessionContextMenu>
            </div>
          )}
          {scheduledTaskId && scheduledTask && (
            <div className="flex items-center gap-2 min-w-0">
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 hidden md:block" />
              <div className="flex items-center gap-1 text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span className="truncate text-xs md:text-sm">
                  {scheduledTask.name || 'Scheduled Task'}
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-0 md:gap-2 shrink-0 app-no-drag">
          {sessionId && contextPercent != null && (
            <DonutChart
              percent={contextPercent}
              tooltip={`Context window: ${contextPercent}%`}
              animated={isActive}
              onClick={() => setContextBarExpanded(v => !v)}
            />
          )}
          {!isViewOnly && (
            <div className="hidden md:flex items-center gap-2">
              {agent?.status === 'running' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => stopAgent.mutate(agentSlug)}
                  disabled={stopAgent.isPending}
                >
                  <Square className="mr-2 h-4 w-4" />
                  Stop
                </Button>
              ) : (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => startAgent.mutate(agentSlug)}
                          disabled={startAgent.isPending || !isRuntimeReady}
                        >
                          {isPulling ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Play className="mr-2 h-4 w-4" />
                          )}
                          Start
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {!apiKeyConfigured && (
                      <TooltipContent>
                        <p>No API key configured. An administrator needs to set up the LLM API key.</p>
                      </TooltipContent>
                    )}
                    {apiKeyConfigured && !isRuntimeReady && readiness && (
                      <TooltipContent>
                        <p>{readiness.message}</p>
                        {readiness.pullProgress && readiness.pullProgress.percent != null && (
                          <p className="text-xs opacity-80">{readiness.pullProgress.status} ({readiness.pullProgress.percent}%)</p>
                        )}
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => selectSession(null)}
              >
                <Plus className="mr-2 h-4 w-4" />
                New Session
              </Button>
            </div>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSettingsOpen(true)}
            data-testid="agent-settings-button"
          >
            <Settings className="h-4 w-4" />
            <span className="sr-only">Agent Settings</span>
          </Button>
        </div>
      </header>

      {/* Image pull progress indicator */}
      {isPulling && readiness?.pullProgress && (
        <div className="shrink-0 border-b bg-muted/30 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Pulling agent image... {readiness.pullProgress.status}</span>
            {readiness.pullProgress.percent != null && (
              <span>({readiness.pullProgress.percent}%)</span>
            )}
          </div>
          {readiness.pullProgress.percent != null && (
            <div className="mt-1 h-1 w-full bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${readiness.pullProgress.percent}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Start error banner */}
      {startAgent.isError && (
        <div className="shrink-0 border-b bg-destructive/10 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span>Failed to start agent: {startAgent.error.message}</span>
          </div>
        </div>
      )}

      {/* Health warning banner */}
      {agent?.healthWarnings?.map((warning) => (
        <div
          key={warning.checkName}
          className={`shrink-0 border-b px-4 py-2 ${
            warning.status === 'critical'
              ? 'bg-destructive/10'
              : 'bg-yellow-500/10'
          }`}
        >
          <div className={`flex items-center gap-2 text-xs ${
            warning.status === 'critical'
              ? 'text-destructive'
              : 'text-yellow-700 dark:text-yellow-400'
          }`}>
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>{warning.message}</span>
          </div>
        </div>
      ))}

      {/* Missing mount warning banner */}
      {mountWarning && mountWarning.missingMounts.length > 0 && (
        <div className="shrink-0 border-b bg-yellow-500/10 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-yellow-700 dark:text-yellow-400">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="flex-1">
              Some mounted folders were not found and have been skipped: {mountWarning.missingMounts.map((m) => m.folderName).join(', ')}
            </span>
            <button
              onClick={dismissMountWarning}
              className="text-yellow-700 dark:text-yellow-400 hover:text-foreground transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Context window usage bar (expanded) */}
      {sessionId && contextPercent != null && contextBarExpanded && (
        <div className="shrink-0 border-b px-4 py-1.5 flex items-center gap-2">
          <span className="text-xs text-muted-foreground whitespace-nowrap">Context</span>
          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 relative overflow-hidden ${
                contextPercent >= 70
                  ? 'bg-destructive'
                  : contextPercent >= 50
                    ? 'bg-yellow-500'
                    : 'bg-primary'
              }`}
              style={{ width: `${Math.min(contextPercent, 100)}%` }}
            >
              {isActive && (
                <div
                  className="absolute inset-0 animate-shimmer"
                  style={{
                    backgroundImage: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.3) 50%, transparent 100%)',
                    backgroundSize: '200% 100%',
                  }}
                />
              )}
            </div>
          </div>
          <span className={`text-xs tabular-nums whitespace-nowrap ${
            contextPercent >= 70
              ? 'text-destructive'
              : contextPercent >= 50
                ? 'text-yellow-600 dark:text-yellow-400'
                : 'text-muted-foreground'
          }`}>
            {contextPercent}%
          </span>
          <button
            onClick={() => setContextBarExpanded(false)}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Automated session indicator — links back to the parent trigger/schedule */}
      {sessionId && session?.scheduledTaskId && (
        <div className="shrink-0 border-b bg-background px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <button
              onClick={() => selectScheduledTask(session.scheduledTaskId!)}
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
              onClick={() => selectWebhookTrigger(session.webhookTriggerId!)}
              className="inline-flex items-center gap-1 text-primary hover:underline shrink-0"
            >
              <ChevronLeft className="h-3 w-3" />
              View trigger
            </button>
            <span className="mx-1 text-border">|</span>
            <Webhook className="h-3 w-3 shrink-0" />
            <span>
              Session created by webhook trigger{session.webhookTriggerName ? ` "${session.webhookTriggerName}"` : ''}
            </span>
          </div>
        </div>
      )}

      {/* Show dashboard view when a dashboard is selected */}
      <ErrorBoundary>
        {dashboardSlug ? (
          <DashboardView agentSlug={agentSlug} dashboardSlug={dashboardSlug} />
        ) : /* Show scheduled task view when a scheduled task is selected */
        scheduledTaskId ? (
          <ScheduledTaskView taskId={scheduledTaskId} agentSlug={agentSlug} />
        ) : /* Show webhook trigger view when a webhook trigger is selected */
        webhookTriggerId ? (
          <WebhookTriggerView triggerId={webhookTriggerId} agentSlug={agentSlug} />
        ) : sessionId ? (
          /* Show messages when a session is selected */
          <div className="relative flex-1 flex min-h-0">
            {/* Chat column */}
            <div className="flex-1 min-w-0 grid grid-rows-[1fr_auto] min-h-0">
              <MessageList
                sessionId={sessionId}
                agentSlug={agentSlug}
                pendingUserMessage={pendingUserMessage}
                onPendingMessageAppeared={handlePendingMessageAppeared}
              />
              <div className="bg-background">
                <AgentActivityIndicator sessionId={sessionId} agentSlug={agentSlug} />
                <MessageInput
                  sessionId={sessionId}
                  agentSlug={agentSlug}
                  onMessageSent={handleMessageSent}
                />
              </div>
            </div>
            {/* Browser drawer panel */}
            <BrowserDrawerPanel agentSlug={agentSlug} sessionId={sessionId} browserActive={browserActive} isActive={isActive} />
          </div>
        ) : (
          /* Show landing page with large input when no session is selected */
          agent && (
            <AgentLanding
              agent={agent}
              onSessionCreated={handleSessionCreated}
            />
          )
        )}
      </ErrorBoundary>

      {agent && (
        <AgentSettingsDialog
          agent={agent}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
    </div>
  )
}

if (__RENDER_TRACKING__) {
  (MainContent as any).whyDidYouRender = true
}
