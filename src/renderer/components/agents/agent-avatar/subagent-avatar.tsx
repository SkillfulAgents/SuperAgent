import { Workflow } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

interface SubagentAvatarProps {
  /** What identifies the subagent: kept for callers that pass it; every subagent wears the same mark. */
  seed?: string
  /** Size in px. */
  size?: number
  /** A working subagent's mark is drawn in the foreground colour, an idle or finished one muted. */
  state?: 'idle' | 'working' | 'done' | 'needs-input' | string
  className?: string
}

/**
 * Every subagent, and every agent of a workflow, wears lucide's workflow
 * icon: work this agent handed off. Decorative: the text beside it says which
 * subagent and what it is doing.
 */
export function SubagentAvatar({ size = 16, state = 'idle', className }: SubagentAvatarProps) {
  return (
    <Workflow
      aria-hidden
      width={size}
      height={size}
      strokeWidth={size <= 16 ? 2 : 1.75}
      className={cn('shrink-0', state === 'working' || state === 'needs-input' ? 'text-foreground' : 'text-muted-foreground', className)}
      data-testid="subagent-icon"
    />
  )
}
