
import { MessageList } from '@renderer/components/messages/message-list'
import { MessageInput } from '@renderer/components/messages/message-input'
import { AgentActivityIndicator } from '@renderer/components/messages/agent-activity-indicator'
import { AgentSettingsDialog } from '@renderer/components/agents/agent-settings-dialog'
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { AgentLanding } from '@renderer/components/agents/agent-landing'
import { Button } from '@renderer/components/ui/button'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Plus, Play, Square, ChevronRight, Settings } from 'lucide-react'
import { useState, useCallback } from 'react'
import { useAgent, useStartAgent, useStopAgent } from '@renderer/hooks/use-agents'
import { useSessions, useSession } from '@renderer/hooks/use-sessions'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { useSelection } from '@renderer/context/selection-context'
import { isElectron, getPlatform } from '@renderer/lib/env'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFullScreen } from '@renderer/hooks/use-fullscreen'

export function MainContent() {
  const { selectedAgentSlug: agentSlug, selectedSessionId: sessionId, selectSession } = useSelection()
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Track pending user message that hasn't appeared in real data yet
  const [pendingUserMessage, setPendingUserMessage] = useState<string | null>(null)
  const { data: agent } = useAgent(agentSlug)
  const { data: sessions } = useSessions(agentSlug)
  const { data: session } = useSession(sessionId, agentSlug)
  const startAgent = useStartAgent()
  const stopAgent = useStopAgent()
  const hasActiveSessions = sessions?.some((s) => s.isActive) ?? false
  const { state: sidebarState } = useSidebar()
  const isFullScreen = useFullScreen()

  // Add left padding for macOS traffic lights when sidebar is collapsed in Electron (not in full screen)
  const needsTrafficLightPadding = isElectron() && getPlatform() === 'darwin' && sidebarState === 'collapsed' && !isFullScreen

  // Callback for MessageInput to set pending message
  const handleMessageSent = useCallback((content: string) => {
    setPendingUserMessage(content)
  }, [])

  // Callback for MessageList to clear pending message when it appears in real data
  const handlePendingMessageAppeared = useCallback(() => {
    setPendingUserMessage(null)
  }, [])

  // Callback for AgentLanding when a new session is created with initial message
  const handleSessionCreated = useCallback((sessionId: string, initialMessage: string) => {
    setPendingUserMessage(initialMessage)
    selectSession(sessionId)
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
    <div className="h-full flex flex-col">
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => startAgent.mutate(agentSlug)}
              disabled={startAgent.isPending}
            >
              <Play className="mr-2 h-4 w-4" />
              Start
            </Button>
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
          >
            <Settings className="h-4 w-4" />
            <span className="sr-only">Agent Settings</span>
          </Button>
        </div>
      </header>

      {/* Show messages when a session is selected, otherwise show landing page */}
      {sessionId ? (
        <div className="flex-1 grid grid-rows-[1fr_auto] min-h-0">
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
      ) : (
        /* Show landing page with large input when no session is selected */
        agent && (
          <AgentLanding
            agent={agent}
            onSessionCreated={handleSessionCreated}
          />
        )
      )}

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
