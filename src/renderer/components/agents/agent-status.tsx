import { Moon, CircleDashed } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import type { ContainerStatus } from '@shared/lib/container/types'
import { type AgentActivityStatus, getAgentActivityStatus } from '@shared/lib/types/agent-activity-status'
import { useDotMatrixIndicators } from '@renderer/hooks/use-dot-matrix-indicators'
import { WorkingDots, AwaitingDot, IdleDots } from './status-indicators'

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
  workingDotClassName?: string
  className?: string
}

export function AgentStatus({ status, hasActiveSessions = false, hasSessionsAwaitingInput = false, size = 'default', iconOnly = false, workingDotClassName, className }: AgentStatusProps) {
  const activityStatus = getAgentActivityStatus(status, hasActiveSessions, hasSessionsAwaitingInput)
  const isSmall = size === 'sm'
  const dotMatrix = useDotMatrixIndicators()

  return (
    <div
      className={cn(
        'flex items-center',
        iconOnly ? 'w-4 justify-center' : (isSmall ? 'gap-1' : 'gap-1.5'),
        className
      )}
      role={iconOnly ? 'img' : undefined}
      data-testid="agent-status"
      data-status={activityStatus}
      aria-label={iconOnly ? statusLabels[activityStatus] : undefined}
      title={iconOnly ? statusLabels[activityStatus] : undefined}
    >
      {activityStatus === 'sleeping' ? (
        <Moon className="h-2.5 w-2.5 text-muted-foreground/70" />
      ) : activityStatus === 'awaiting_input' ? (
        <AwaitingDot />
      ) : activityStatus === 'working' ? (
        <WorkingDots dotClassName={workingDotClassName} />
      ) : dotMatrix ? (
        <IdleDots />
      ) : (
        <CircleDashed className="h-2.5 w-2.5 text-muted-foreground" />
      )}
      {!iconOnly && (
        <span
          className={cn(isSmall ? 'text-2xs' : 'text-xs', {
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
