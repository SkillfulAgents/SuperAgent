import { Moon } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import type { ContainerStatus } from '@shared/lib/container/types'

export type AgentActivityStatus = 'sleeping' | 'idle' | 'working' | 'awaiting_input'

const statusLabels: Record<AgentActivityStatus, string> = {
  sleeping: 'sleeping',
  idle: 'idle',
  working: 'working',
  awaiting_input: 'awaiting input',
}

interface AgentStatusProps {
  status: ContainerStatus
  hasActiveSessions?: boolean
  hasSessionsAwaitingInput?: boolean
  className?: string
}

export function getAgentActivityStatus(
  containerStatus: ContainerStatus,
  hasActiveSessions: boolean,
  hasSessionsAwaitingInput: boolean = false
): AgentActivityStatus {
  if (containerStatus === 'stopped') return 'sleeping'
  if (hasSessionsAwaitingInput) return 'awaiting_input'
  if (hasActiveSessions) return 'working'
  return 'idle'
}

export function AgentStatus({ status, hasActiveSessions = false, hasSessionsAwaitingInput = false, className }: AgentStatusProps) {
  const activityStatus = getAgentActivityStatus(status, hasActiveSessions, hasSessionsAwaitingInput)

  return (
    <div className={cn('flex items-center gap-1.5', className)} data-testid="agent-status" data-status={activityStatus}>
      {activityStatus === 'sleeping' ? (
        <Moon className="h-3 w-3 text-muted-foreground" />
      ) : activityStatus === 'awaiting_input' ? (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-500 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-orange-500"></span>
        </span>
      ) : activityStatus === 'working' ? (
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
        </span>
      ) : (
        <div className="h-2 w-2 rounded-full bg-blue-500" />
      )}
      <span
        className={cn('text-xs', {
          'text-muted-foreground': activityStatus === 'sleeping',
          'text-blue-500': activityStatus === 'idle',
          'text-green-600': activityStatus === 'working',
          'text-orange-500': activityStatus === 'awaiting_input',
        })}
      >
        {statusLabels[activityStatus]}
      </span>
    </div>
  )
}
