'use client'

import { MessageList } from '@/components/messages/message-list'
import { MessageInput } from '@/components/messages/message-input'
import { AgentActivityIndicator } from '@/components/messages/agent-activity-indicator'
import { CreateSessionDialog } from '@/components/sessions/create-session-dialog'
import { AgentSettingsDialog } from '@/components/agents/agent-settings-dialog'
import { SessionContextMenu } from '@/components/sessions/session-context-menu'
import { AgentLanding } from '@/components/agents/agent-landing'
import { Button } from '@/components/ui/button'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Plus, Play, Square, ChevronRight, Settings } from 'lucide-react'
import { useState } from 'react'
import { useAgent, useStartAgent, useStopAgent } from '@/lib/hooks/use-agents'
import { useSessions, useSession } from '@/lib/hooks/use-sessions'
import { AgentStatus } from '@/components/agents/agent-status'
import { useSelection } from '@/lib/context/selection-context'

export function MainContent() {
  const { selectedAgentId: agentId, selectedSessionId: sessionId, selectSession } = useSelection()
  const [createSessionOpen, setCreateSessionOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { data: agent } = useAgent(agentId)
  const { data: sessions } = useSessions(agentId)
  const { data: session } = useSession(sessionId)
  const startAgent = useStartAgent()
  const stopAgent = useStopAgent()
  const hasActiveSessions = sessions?.some((s) => s.isActive) ?? false

  if (!agentId) {
    return (
      <div className="flex-1 flex flex-col">
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
          <SidebarTrigger className="-ml-1" />
        </header>
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          Select an agent to get started
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* Unified header */}
      <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
        <SidebarTrigger className="-ml-1" />
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="font-semibold truncate">{agent?.name || 'Loading...'}</span>
          {agent && <AgentStatus status={agent.status} hasActiveSessions={hasActiveSessions} />}
          {sessionId && session?.agentId === agentId && (
            <>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              <SessionContextMenu
                sessionId={sessionId}
                sessionName={session?.name || 'Session'}
              >
                <span className="text-muted-foreground truncate cursor-context-menu">
                  {session?.name || 'Loading...'}
                </span>
              </SessionContextMenu>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {agent?.status === 'running' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => stopAgent.mutate(agentId)}
              disabled={stopAgent.isPending}
            >
              <Square className="mr-2 h-4 w-4" />
              Stop
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => startAgent.mutate(agentId)}
              disabled={startAgent.isPending}
            >
              <Play className="mr-2 h-4 w-4" />
              Start
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCreateSessionOpen(true)}
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
        <div className="flex-1 flex flex-col min-h-0">
          <MessageList sessionId={sessionId} />
          <AgentActivityIndicator sessionId={sessionId} />
          <MessageInput sessionId={sessionId} agentId={agentId} />
        </div>
      ) : (
        /* Show landing page with large input when no session is selected */
        agent && (
          <AgentLanding
            agent={agent}
            onSessionCreated={selectSession}
          />
        )
      )}

      <CreateSessionDialog
        agentId={agentId}
        open={createSessionOpen}
        onOpenChange={setCreateSessionOpen}
        onCreated={selectSession}
      />

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
