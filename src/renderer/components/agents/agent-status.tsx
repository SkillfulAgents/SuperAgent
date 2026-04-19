import { Moon } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import type { ContainerStatus } from '@shared/lib/container/types'

export type AgentActivityStatus = 'sleeping' | 'idle' | 'working' | 'awaiting_input'

const statusLabels: Record<AgentActivityStatus, string> = {
  sleeping: 'sleeping',
  idle: 'idle',
  working: 'working',
  awaiting_input: 'needs input',
}

interface AgentStatusProps {
  status: ContainerStatus
  hasActiveSessions?: boolean
  hasSessionsAwaitingInput?: boolean
  size?: 'sm' | 'default'
  iconOnly?: boolean
  hideIdle?: boolean
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

export function AgentStatus({ status, hasActiveSessions = false, hasSessionsAwaitingInput = false, size = 'default', iconOnly = false, hideIdle = false, className }: AgentStatusProps) {
  const activityStatus = getAgentActivityStatus(status, hasActiveSessions, hasSessionsAwaitingInput)
  if (hideIdle && activityStatus === 'idle') return null
  const isSmall = size === 'sm'
  const iconSize = 'h-2.5 w-2.5'
  const dotSize = 'h-1.5 w-1.5'

  return (
    <div
      className={cn(
        'flex items-center',
        iconOnly ? 'w-4 justify-center' : (isSmall ? 'gap-1' : 'gap-1.5'),
        className
      )}
      data-testid="agent-status"
      data-status={activityStatus}
      aria-label={iconOnly ? statusLabels[activityStatus] : undefined}
      title={iconOnly ? statusLabels[activityStatus] : undefined}
    >
      {activityStatus === 'sleeping' ? (
        <Moon className={cn(iconSize, 'text-muted-foreground')} />
      ) : activityStatus === 'awaiting_input' ? (
        <span className={cn('relative flex', dotSize)}>
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-500 opacity-75"></span>
          <span className={cn('relative inline-flex rounded-full bg-orange-500', dotSize)}></span>
        </span>
      ) : activityStatus === 'working' ? (
        <span className="inline-flex items-center gap-0.5">
          <span className="h-[3px] w-[3px] rounded-full bg-foreground animate-dot-wave" />
          <span className="h-[3px] w-[3px] rounded-full bg-foreground animate-dot-wave [animation-delay:0.15s]" />
          <span className="h-[3px] w-[3px] rounded-full bg-foreground animate-dot-wave [animation-delay:0.3s]" />
        </span>
      ) : (
        <div className={cn('rounded-full bg-muted-foreground', dotSize)} />
      )}
      {!iconOnly && (
        <span
          className={cn(isSmall ? 'text-[10px]' : 'text-xs', {
            'text-muted-foreground': activityStatus === 'sleeping' || activityStatus === 'idle',
            'text-foreground': activityStatus === 'working',
            'text-orange-500': activityStatus === 'awaiting_input',
          })}
        >
          {statusLabels[activityStatus]}
        </span>
      )}
    </div>
  )
}
