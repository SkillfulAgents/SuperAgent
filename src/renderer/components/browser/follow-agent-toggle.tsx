import { useId } from 'react'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@shared/lib/utils/cn'

interface FollowAgentToggleProps {
  autoFollow: boolean
  onToggle: () => void
  className?: string
}

/**
 * Whether the viewer tracks the agent's active tab. On, the screencast jumps
 * with the agent; off, the viewer stays pinned to the tab they picked. A
 * labelled switch, like the Compact View toggle in the home card menu, on the
 * Activity row with the other session controls.
 */
export function FollowAgentToggle({ autoFollow, onToggle, className }: FollowAgentToggleProps) {
  const id = useId()
  const title = autoFollow ? 'Auto-following agent (click to pin)' : 'Not following agent (click to follow)'
  return (
    <div className={cn('inline-flex h-6 items-center gap-1.5 pl-1.5 pr-1', className)} title={title}>
      <label htmlFor={id} className="cursor-pointer select-none text-xs text-muted-foreground">
        Follow agent
      </label>
      <Switch
        id={id}
        checked={autoFollow}
        onCheckedChange={onToggle}
        aria-label={title}
        data-testid="follow-agent-toggle"
        // Compact for the row: a 16px track with the thumb scaled to fit.
        className="h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3"
      />
    </div>
  )
}
