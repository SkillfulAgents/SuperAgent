import { cn } from '@shared/lib/utils/cn'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { Switch } from '@renderer/components/ui/switch'
import type { ApiAgent } from '@renderer/hooks/use-agents'

/** The switch that gives Team Brain to every agent, including ones made later. Only a drive everyone can add can go to all. */
export function EveryAgentRow({
  checked,
  canGoGlobal,
  onCheckedChange,
  className,
}: {
  checked: boolean
  canGoGlobal: boolean
  onCheckedChange: (on: boolean) => void
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-3', className)} data-testid="team-brain-every-agent">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium">Every agent</span>
        <span className="block text-[12px] text-muted-foreground">
          {canGoGlobal ? 'Includes agents you make later.' : 'Only a drive everyone can add can go to every agent.'}
        </span>
      </span>
      <Switch checked={checked} disabled={!canGoGlobal} onCheckedChange={onCheckedChange} aria-label="Every agent" data-testid="team-brain-every-agent-switch" />
    </div>
  )
}

/**
 * Each agent with a switch for whether it uses Team Brain: on, it reads the
 * brain and can message the Team Brain agent to add to it. With `everyAgent`,
 * all show on and locked: the global drive covers every agent.
 */
export function AgentAccessList({
  agents,
  everyAgent = false,
  isOn,
  isChanging,
  disabled = false,
  onToggle,
  className,
  rowClassName,
}: {
  agents: readonly ApiAgent[]
  everyAgent?: boolean
  isOn: (slug: string) => boolean
  /** A switch whose change is still under way, held until it lands. */
  isChanging?: (slug: string) => boolean
  /** Shown but not changeable, for someone who may not change it. */
  disabled?: boolean
  onToggle: (slug: string, on: boolean) => void
  className?: string
  rowClassName?: string
}) {
  return (
    <ul className={cn('divide-y divide-border/60', className)} data-testid="team-brain-agent-access">
      {agents.map((agent) => {
        const on = everyAgent || isOn(agent.slug)
        return (
          <li key={agent.slug} className={cn('flex items-center gap-3 py-3', rowClassName)}>
            <AgentAvatar agent={agent} size={22} />
            <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', !on && 'text-muted-foreground')}>{agent.name}</span>
            <Switch
              checked={on}
              disabled={disabled || everyAgent || !!isChanging?.(agent.slug)}
              onCheckedChange={(next) => onToggle(agent.slug, next)}
              aria-label={`${agent.name} uses Team Brain`}
              data-testid={`team-brain-agent-${agent.slug}`}
            />
          </li>
        )
      })}
    </ul>
  )
}
