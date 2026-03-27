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
  size?: 'sm' | 'default'
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

export function AgentStatus({ status, hasActiveSessions = false, hasSessionsAwaitingInput = false, size = 'default', className }: AgentStatusProps) {
  const activityStatus = getAgentActivityStatus(status, hasActiveSessions, hasSessionsAwaitingInput)
  const isSmall = size === 'sm'
  const iconSize = isSmall ? 'h-2.5 w-2.5' : 'h-3 w-3'
  const dotSize = isSmall ? 'h-1.5 w-1.5' : 'h-2 w-2'

  return (
    <div className={cn('flex items-center', isSmall ? 'gap-1' : 'gap-1.5', className)} data-testid="agent-status" data-status={activityStatus}>
      {activityStatus === 'sleeping' ? (
        <Moon className={cn(iconSize, 'text-muted-foreground')} />
      ) : activityStatus === 'awaiting_input' ? (
        <span className={cn('relative flex', dotSize)}>
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-500 opacity-75"></span>
          <span className={cn('relative inline-flex rounded-full bg-orange-500', dotSize)}></span>
        </span>
      ) : activityStatus === 'working' ? (
        <span className={cn('relative flex', dotSize)}>
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75"></span>
          <span className={cn('relative inline-flex rounded-full bg-green-500', dotSize)}></span>
        </span>
      ) : (
        <div className={cn('rounded-full bg-blue-500', dotSize)} />
      )}
      <span
        className={cn(isSmall ? 'text-[10px]' : 'text-xs', {
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
