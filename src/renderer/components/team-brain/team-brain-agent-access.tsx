import { cn } from '@shared/lib/utils/cn'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { Switch } from '@renderer/components/ui/switch'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import { usesTeamBrain, useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'

/**
 * Each agent with a switch for whether it uses Team Brain: on, it reads the
 * brain and can message the Team Brain agent to add to it. Written straight
 * to the Team Brain state. With `everyAgent`, all show on and locked: the
 * global drive covers every agent.
 */
export function AgentAccessList({
  agents,
  everyAgent = false,
  className,
  rowClassName,
}: {
  agents: readonly ApiAgent[]
  everyAgent?: boolean
  className?: string
  rowClassName?: string
}) {
  const tb = useTeamBrain()
  return (
    <ul className={cn('divide-y divide-border/60', className)} data-testid="team-brain-agent-access">
      {agents.map((agent) => {
        const on = everyAgent || usesTeamBrain(tb.state, agent.slug)
        return (
          <li key={agent.slug} className={cn('flex items-center gap-3 py-3', rowClassName)}>
            <AgentAvatar agent={agent} size={22} />
            <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', !on && 'text-muted-foreground')}>{agent.name}</span>
            <Switch
              checked={on}
              disabled={everyAgent}
              onCheckedChange={(next) => tb.setUsesTeamBrain(agent.slug, next)}
              aria-label={`${agent.name} uses Team Brain`}
              data-testid={`team-brain-agent-${agent.slug}`}
            />
          </li>
        )
      })}
    </ul>
  )
}
