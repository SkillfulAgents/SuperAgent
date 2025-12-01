'use client'

import { cn } from '@/lib/utils/cn'
import { AgentStatus } from './agent-status'
import type { AgentWithStatus } from '@/lib/hooks/use-agents'

interface AgentListItemProps {
  agent: AgentWithStatus
  selected: boolean
  onClick: () => void
}

export function AgentListItem({ agent, selected, onClick }: AgentListItemProps) {
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
      <AgentStatus status={agent.status} />
    </button>
  )
}
