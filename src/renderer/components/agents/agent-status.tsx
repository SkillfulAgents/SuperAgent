import { Moon, CircleDashed } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import type { ContainerStatus } from '@shared/lib/container/types'
import { type AgentActivityStatus, getAgentActivityStatus } from '@shared/lib/types/agent-activity-status'
import { WorkingDots, AwaitingDot } from './status-indicators'

const statusLabels: Record<AgentActivityStatus, string> = {
  sleeping: 'sleeping',
  idle: 'idle',
  working: 'working',
  awaiting_input: 'needs input',
}

interface AgentStatusProps {
  status: ContainerStatus
  runtime?: 'local' | 'cloud'
  hasActiveSessions?: boolean
  hasSessionsAwaitingInput?: boolean
  size?: 'sm' | 'default'
  iconOnly?: boolean
  workingDotClassName?: string
  className?: string
}

export function AgentStatus({ status, runtime = 'local', hasActiveSessions = false, hasSessionsAwaitingInput = false, size = 'default', iconOnly = false, workingDotClassName, className }: AgentStatusProps) {
  const activityStatus = getAgentActivityStatus(status, hasActiveSessions, hasSessionsAwaitingInput)
  const isSmall = size === 'sm'
  const label = `${runtime === 'cloud' ? 'Cloud' : 'Local'} ${statusLabels[activityStatus]}`

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
      data-runtime={runtime}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
    >
      {activityStatus === 'sleeping' ? (
        <Moon className="h-2.5 w-2.5 text-muted-foreground/70" />
      ) : activityStatus === 'awaiting_input' ? (
        <AwaitingDot />
      ) : activityStatus === 'working' ? (
        <WorkingDots dotClassName={workingDotClassName} />
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
          {label}
        </span>
      )}
    </div>
  )
}
