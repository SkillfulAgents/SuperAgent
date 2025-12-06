'use client'

import { SessionList } from '@/components/sessions/session-list'
import { MessageList } from '@/components/messages/message-list'
import { MessageInput } from '@/components/messages/message-input'
import { AgentActivityIndicator } from '@/components/messages/agent-activity-indicator'
import { CreateSessionDialog } from '@/components/sessions/create-session-dialog'
import { AgentLanding } from '@/components/agents/agent-landing'
import { Button } from '@/components/ui/button'
import { Plus, Play, Square } from 'lucide-react'
import { useState } from 'react'
import { useAgent, useStartAgent, useStopAgent } from '@/lib/hooks/use-agents'
import { AgentStatus } from '@/components/agents/agent-status'

interface MainContentProps {
  agentId: string | null
  sessionId: string | null
  onSelectSession: (sessionId: string | null) => void
}

export function MainContent({
  agentId,
  sessionId,
  onSelectSession,
}: MainContentProps) {
  const [createSessionOpen, setCreateSessionOpen] = useState(false)
  const { data: agent } = useAgent(agentId)
  const startAgent = useStartAgent()
  const stopAgent = useStopAgent()

  if (!agentId) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Select an agent to get started
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* Agent header */}
      <div className="p-4 border-b flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">{agent?.name || 'Loading...'}</h2>
          {agent && <AgentStatus status={agent.status} />}
        </div>
        <div className="flex items-center gap-2">
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
        </div>
      </div>

      {/* Sessions tabs - always visible */}
      <SessionList
        agentId={agentId}
        selectedSessionId={sessionId}
        onSelectSession={onSelectSession}
      />

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
            onSessionCreated={onSelectSession}
          />
        )
      )}

      <CreateSessionDialog
        agentId={agentId}
        open={createSessionOpen}
        onOpenChange={setCreateSessionOpen}
        onCreated={(id) => onSelectSession(id)}
      />
    </div>
  )
}
