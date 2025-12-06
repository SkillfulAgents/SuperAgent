'use client'

import { cn } from '@/lib/utils/cn'
import { AgentStatus } from './agent-status'
import { useSessions } from '@/lib/hooks/use-sessions'
import type { AgentWithStatus } from '@/lib/hooks/use-agents'

interface AgentListItemProps {
  agent: AgentWithStatus
  selected: boolean
  onClick: () => void
}

export function AgentListItem({ agent, selected, onClick }: AgentListItemProps) {
  const { data: sessions } = useSessions(agent.id)
  const hasActiveSessions = sessions?.some((s) => s.isActive) ?? false

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center justify-between px-3 py-2 rounded-md text-left transition-colors',
        selected
          ? 'bg-accent text-accent-foreground'
          : 'hover:bg-accent/50'
      )}
    >
      <span className="font-medium truncate">{agent.name}</span>
      <AgentStatus status={agent.status} hasActiveSessions={hasActiveSessions} />
    </button>
  )
}
