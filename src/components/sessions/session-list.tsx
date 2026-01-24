'use client'

import { useSessions, type ApiSession } from '@/lib/hooks/use-sessions'
import { useMessageStream } from '@/lib/hooks/use-message-stream'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils/cn'
import { Loader2 } from 'lucide-react'

interface SessionListProps {
  agentSlug: string
  selectedSessionId: string | null
  onSelectSession: (sessionId: string | null) => void
}

// Individual session tab that tracks its own streaming state
function SessionTab({
  session,
  isSelected,
  onClick,
}: {
  session: ApiSession
  isSelected: boolean
  onClick: () => void
}) {
  // Use SSE to get real-time streaming state for the selected session
  const { isStreaming } = useMessageStream(isSelected ? session.id : null)

  // Show as active if API says so OR if we're currently streaming
  const showActive = session.isActive || isStreaming

  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 text-sm rounded-md whitespace-nowrap transition-colors flex items-center gap-2',
        isSelected
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted hover:bg-muted/80'
      )}
    >
      {showActive && (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-current"></span>
        </span>
      )}
      {session.name}
    </button>
  )
}

export function SessionList({
  agentSlug,
  selectedSessionId,
  onSelectSession,
}: SessionListProps) {
  const { data: sessions, isLoading } = useSessions(agentSlug)

  if (isLoading) {
    return (
      <div className="border-b p-2">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!sessions?.length) {
    return (
      <div className="border-b p-2 text-sm text-muted-foreground">
        No sessions yet
      </div>
    )
  }

  return (
    <ScrollArea className="border-b">
      <div className="flex p-2 gap-1">
        {sessions.map((session) => (
          <SessionTab
            key={session.id}
            session={session}
            isSelected={session.id === selectedSessionId}
            onClick={() => onSelectSession(session.id)}
          />
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}
