
import { MessageList } from '@renderer/components/messages/message-list'
import { MessageInput } from '@renderer/components/messages/message-input'
import { AgentActivityIndicator } from '@renderer/components/messages/agent-activity-indicator'
import { AgentSettingsDialog } from '@renderer/components/agents/agent-settings-dialog'
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { AgentLanding } from '@renderer/components/agents/agent-landing'
import { ScheduledTaskView } from '@renderer/components/scheduled-tasks/scheduled-task-view'
import { BrowserPreview } from '@renderer/components/browser/browser-preview'
import { DashboardView } from '@renderer/components/dashboards/dashboard-view'
import { Button } from '@renderer/components/ui/button'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import { Plus, Play, Square, ChevronRight, Settings, Clock, Loader2, AlertCircle, AlertTriangle } from 'lucide-react'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useAgent, useStartAgent, useStopAgent } from '@renderer/hooks/use-agents'
import { useSessions, useSession } from '@renderer/hooks/use-sessions'
import { useScheduledTask } from '@renderer/hooks/use-scheduled-tasks'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { useSelection } from '@renderer/context/selection-context'
import { useSettings } from '@renderer/hooks/use-settings'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'
import { useMarkSessionNotificationsRead } from '@renderer/hooks/use-notifications'
import { useMessageStream } from '@renderer/hooks/use-message-stream'

export function MainContent() {
  const {
    selectedAgentSlug: agentSlug,
    selectedSessionId: sessionId,
    selectedScheduledTaskId: scheduledTaskId,
    selectedDashboardSlug: dashboardSlug,
    selectSession,
  } = useSelection()
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Pending user messages per session — survives navigation between sessions
  const pendingMessagesRef = useRef(new Map<string, string>())
  const [, forceUpdate] = useState(0)
  const { data: agent } = useAgent(agentSlug)
  const { data: sessions } = useSessions(agentSlug)
  const { data: session } = useSession(sessionId, agentSlug)
  const { data: scheduledTask } = useScheduledTask(scheduledTaskId)
  const startAgent = useStartAgent()
  const stopAgent = useStopAgent()
  const hasActiveSessions = sessions?.some((s) => s.isActive) ?? false
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()
  const markSessionNotificationsRead = useMarkSessionNotificationsRead()
  const { browserActive, isActive } = useMessageStream(sessionId ?? null, agentSlug ?? null)
  const { data: settingsData } = useSettings()
  const readiness = settingsData?.runtimeReadiness
  const isRuntimeReady = readiness?.status === 'READY'
  const isPulling = readiness?.status === 'PULLING_IMAGE'

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
      pendingMessagesRef.current.set(sessionId, content)
      forceUpdate((n) => n + 1)
    }
  }, [sessionId])

  const handlePendingMessageAppeared = useCallback(() => {
    if (sessionId) {
      pendingMessagesRef.current.delete(sessionId)
      forceUpdate((n) => n + 1)
    }
  }, [sessionId])

  // Callback for AgentLanding when a new session is created with initial message
  const handleSessionCreated = useCallback((newSessionId: string, initialMessage: string) => {
    pendingMessagesRef.current.set(newSessionId, initialMessage)
    selectSession(newSessionId)
  }, [selectSession])

  if (!agentSlug) {
    return (
      <div className="h-full flex flex-col">
        <header
          className={`shrink-0 flex h-12 items-center gap-2 border-b bg-background px-4 ${isElectron() ? 'app-drag-region' : ''}`}
        >
          <SidebarTrigger
            className={`app-no-drag ${needsTrafficLightPadding ? 'ml-16' : '-ml-1'}`}
          />
        </header>
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          Select an agent to get started
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col" data-testid="main-content">
      {/* Fixed header - draggable region for Electron */}
      <header
        className={`shrink-0 flex h-12 items-center gap-2 border-b bg-background px-4 ${isElectron() ? 'app-drag-region' : ''}`}
      >
        <SidebarTrigger
          className={`app-no-drag ${needsTrafficLightPadding ? 'ml-16' : '-ml-1'}`}
        />
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="font-semibold truncate">{agent?.name || 'Loading...'}</span>
          {agent && <AgentStatus status={agent.status} hasActiveSessions={hasActiveSessions} />}
          {sessionId && session?.agentSlug === agentSlug && (
            <>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              <SessionContextMenu
                sessionId={sessionId}
                sessionName={session?.name || 'Session'}
                agentSlug={agentSlug}
              >
                <span className="text-muted-foreground truncate cursor-context-menu app-no-drag">
                  {session?.name || 'Loading...'}
                </span>
              </SessionContextMenu>
            </>
          )}
          {scheduledTaskId && scheduledTask && (
            <>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex items-center gap-1 text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span className="truncate">
                  {scheduledTask.name || 'Scheduled Task'}
                </span>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 app-no-drag">
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
                {!isRuntimeReady && readiness && (
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

      {/* Show dashboard view when a dashboard is selected */}
      <ErrorBoundary>
        {dashboardSlug ? (
          <DashboardView agentSlug={agentSlug} dashboardSlug={dashboardSlug} />
        ) : /* Show scheduled task view when a scheduled task is selected */
        scheduledTaskId ? (
          <ScheduledTaskView taskId={scheduledTaskId} agentSlug={agentSlug} />
        ) : sessionId ? (
          /* Show messages when a session is selected */
          <div className="relative flex-1 grid grid-rows-[1fr_auto] min-h-0">
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
            <BrowserPreview agentSlug={agentSlug} sessionId={sessionId} browserActive={browserActive} isActive={isActive} />
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
