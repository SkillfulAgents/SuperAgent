import { cn } from '@/lib/utils/cn'
import type { ContainerStatus } from '@/lib/container/types'

interface AgentStatusProps {
  status: ContainerStatus
  className?: string
}

export function AgentStatus({ status, className }: AgentStatusProps) {
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <div
        className={cn('h-2 w-2 rounded-full', {
          'bg-gray-400': status === 'stopped',
          'bg-green-500': status === 'running',
        })}
      />
      <span
        className={cn('text-xs capitalize', {
          'text-gray-500': status === 'stopped',
          'text-green-600': status === 'running',
        })}
      >
        {status}
      </span>
    </div>
  )
}
