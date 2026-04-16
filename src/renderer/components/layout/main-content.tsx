
import { MessageList } from '@renderer/components/messages/message-list'
import { MessageInput } from '@renderer/components/messages/message-input'
import { AgentActivityIndicator } from '@renderer/components/messages/agent-activity-indicator'
import { AgentSettingsDialog } from '@renderer/components/agents/agent-settings-dialog'
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { AgentHome } from '@renderer/components/agents/agent-home/agent-home'
import { HomePage } from '@renderer/components/home/home-page'
import { ScheduledTaskView } from '@renderer/components/scheduled-tasks/scheduled-task-view'
import { WebhookTriggerView } from '@renderer/components/webhook-triggers/webhook-trigger-view'
import { ChatIntegrationView } from '@renderer/components/chat-integrations/chat-integration-view'
import { BrowserDrawerPanel } from '@renderer/components/browser/browser-drawer-panel'
import { DashboardView } from '@renderer/components/dashboards/dashboard-view'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Separator } from '@renderer/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { DonutChart } from '@renderer/components/ui/donut-chart'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { Power, Square, ChevronLeft, Clock, Loader2, AlertCircle, AlertTriangle, X, CalendarClock, Webhook } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
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
    selectedChatIntegrationId: chatIntegrationId,
    selectedDashboardSlug: dashboardSlug,
    selectSession,
    selectScheduledTask,
    selectWebhookTrigger,
  } = useSelection()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined)
  // Pending user messages per session — survives navigation between sessions
  const pendingMessagesRef = useRef(new Map<string, { text: string; sentAt: number; sender?: { id: string; name: string; email: string } }>())
  // Draft input text per session — survives navigation between sessions
  const draftsRef = useRef(new Map<string, string>())
  const [, forceUpdate] = useState(0)
  const { data: agent } = useAgent(agentSlug)
  const { data: sessions } = useSessions(agentSlug)
  const { data: session } = useSession(sessionId, agentSlug)
  const { data: scheduledTask } = useScheduledTask(scheduledTaskId)
  const startAgent = useStartAgent()
  const stopAgent = useStopAgent()
  const hasActiveSessions = sessions?.some((s) => s.isActive) || (agent?.hasActiveSessions ?? false)
  const hasSessionsAwaitingInput = sessions?.some((s) => s.isAwaitingInput) || (agent?.hasSessionsAwaitingInput ?? false)
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
  const currentDraft = sessionId ? (draftsRef.current.get(sessionId) ?? '') : ''

  const handleDraftChange = useCallback((draft: string) => {
    if (sessionId) {
      if (draft) {
        draftsRef.current.set(sessionId, draft)
      } else {
        draftsRef.current.delete(sessionId)
      }
    }
  }, [sessionId])

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

  // Callback for AgentHome when a new session is created with initial message
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

  const showSessionCrumb = !!(sessionId && session?.agentSlug === agentSlug)
  const showTaskCrumb = !!(scheduledTaskId && scheduledTask)
  const isAgentLeaf = !showSessionCrumb && !showTaskCrumb

  return (
    <div className="h-full flex flex-col" data-testid="main-content">
      {/* Fixed header - draggable region for Electron */}
      <header
        className={`shrink-0 flex min-h-12 py-1.5 md:py-0 md:h-12 items-center gap-2 border-b bg-background pl-4 pr-2 ${isElectron() ? 'app-drag-region' : ''}`}
      >
        <SidebarTrigger
          className={`app-no-drag ${needsTrafficLightPadding ? 'ml-16' : '-ml-1'}`}
        />
        <Separator orientation="vertical" className="h-5 hidden md:block" />
        <div className="flex flex-col md:flex-row md:items-center gap-0 md:gap-1.5 min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              className={`text-[13px] font-light truncate transition-colors app-no-drag ${isAgentLeaf ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => selectSession(null)}
            >
              {agent?.name || 'Loading...'}
            </button>
          </div>
          {sessionId && session?.agentSlug === agentSlug && (
            <div className="flex items-center gap-1.5 min-w-0">
              <span aria-hidden="true" className="text-[13px] font-light text-muted-foreground shrink-0 hidden md:block">/</span>
              <SessionContextMenu
                sessionId={sessionId}
                sessionName={session?.name || 'Session'}
                agentSlug={agentSlug}
              >
                <span className="text-[13px] font-light text-foreground truncate cursor-context-menu app-no-drag">
                  {session?.name || 'Loading...'}
                </span>
              </SessionContextMenu>
            </div>
          )}
          {scheduledTaskId && scheduledTask && (
            <div className="flex items-center gap-1.5 min-w-0">
              <span aria-hidden="true" className="text-[13px] font-light text-muted-foreground shrink-0 hidden md:block">/</span>
              <div className="flex items-center gap-1 text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span className="truncate text-[13px] font-light text-foreground">
                  {scheduledTask.name || 'Scheduled Task'}
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-0 md:gap-2 shrink-0 app-no-drag">
          {agent && <AgentStatus status={agent.status} hasActiveSessions={hasActiveSessions} hasSessionsAwaitingInput={hasSessionsAwaitingInput} />}
          {!isViewOnly && (
            <>
              <Separator orientation="vertical" className="h-5 hidden md:block ml-2" />
              <div className="hidden md:flex items-center gap-2">
                {agent?.status === 'running' ? (
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => stopAgent.mutate(agentSlug)}
                          disabled={stopAgent.isPending}
                          aria-label="Stop Agent"
                        >
                          <Square className="h-4 w-4 fill-current" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Stop Agent</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => startAgent.mutate(agentSlug)}
                            disabled={startAgent.isPending || !isRuntimeReady}
                            aria-label="Start Agent"
                          >
                            {isPulling || startAgent.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Power className="h-4 w-4" />
                            )}
                          </Button>
                        </span>
                      </TooltipTrigger>
                      {!apiKeyConfigured ? (
                        <TooltipContent>
                          <p>No API key configured. An administrator needs to set up the LLM API key.</p>
                        </TooltipContent>
                      ) : !isRuntimeReady && readiness ? (
                        <TooltipContent>
                          <p>{readiness.message}</p>
                          {readiness.pullProgress && readiness.pullProgress.percent != null && (
                            <p className="text-xs opacity-80">{readiness.pullProgress.status} ({readiness.pullProgress.percent}%)</p>
                          )}
                        </TooltipContent>
                      ) : (
                        <TooltipContent>
                          <p>Wake up agent</p>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </>
          )}
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
          <div className="flex items-center gap-2 text-xs text-destructive select-text">
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
          <div className={`flex items-center gap-2 text-xs select-text ${
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
          <div className="flex items-center gap-2 text-xs text-yellow-700 dark:text-yellow-400 select-text">
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
        ) : /* Show chat integration view when a chat integration is selected */
        chatIntegrationId ? (
          <ChatIntegrationView integrationId={chatIntegrationId} agentSlug={agentSlug} />
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
              <div className="bg-background max-w-[740px] mx-auto w-full">
                <AgentActivityIndicator sessionId={sessionId} agentSlug={agentSlug} />
                <MessageInput
                  key={sessionId}
                  sessionId={sessionId}
                  agentSlug={agentSlug}
                  onMessageSent={handleMessageSent}
                  initialDraft={currentDraft}
                  onDraftChange={handleDraftChange}
                  initialEffort={session?.effort}
                />
                <div className="flex justify-between items-center gap-1.5 px-6 py-3">
                  {contextPercent != null ? (
                    <TooltipProvider delayDuration={0}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center gap-1.5 cursor-default">
                            <span className="text-xs text-muted-foreground">Context Usage</span>
                            <DonutChart
                              percent={contextPercent}
                              animated={isActive}
                              size="sm"
                              showLabel={false}
                            />
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{contextPercent}%</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <span />
                  )}
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <kbd className="inline-flex items-center justify-center rounded-sm bg-muted border border-border/50 px-1 h-4 text-[11px] font-sans leading-none">↵</kbd>
                    <span>Send</span>
                    <span className="mx-1">·</span>
                    <kbd className="inline-flex items-center justify-center rounded-sm bg-muted border border-border/50 px-1 h-4 text-[11px] font-sans leading-none">⇧↵</kbd>
                    <span>New line</span>
                  </span>
                </div>
              </div>
            </div>
            {/* Browser drawer panel */}
            <BrowserDrawerPanel agentSlug={agentSlug} sessionId={sessionId} browserActive={browserActive} isActive={isActive} />
          </div>
        ) : (
          /* Show home page with large input when no session is selected */
          agent && (
            <AgentHome
              agent={agent}
              onSessionCreated={handleSessionCreated}
              onOpenSettings={(tab?: string) => { setSettingsTab(tab); setSettingsOpen(true) }}
            />
          )
        )}
      </ErrorBoundary>

      {agent && (
        <AgentSettingsDialog
          agent={agent}
          open={settingsOpen}
          onOpenChange={(open) => { setSettingsOpen(open); if (!open) setSettingsTab(undefined) }}
          initialTab={settingsTab}
        />
      )}
    </div>
  )
}

if (__RENDER_TRACKING__) {
  (MainContent as any).whyDidYouRender = true
}
