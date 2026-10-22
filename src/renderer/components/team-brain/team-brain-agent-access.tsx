import { cn } from '@shared/lib/utils/cn'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import { agentAccessOf, useTeamBrain } from '@renderer/lib/team-brain/team-brain-store'
import { TEAM_BRAIN_ACCESS, type TeamBrainAccess } from '@renderer/lib/team-brain/team-brain-schema'

const ACCESS_LABELS: Record<TeamBrainAccess, string> = { read: 'Read', write: 'Write', both: 'Both' }

/**
 * Each agent with what it may do with Team Brain: Read, Write or Both, one
 * pressed. Pressing the pressed one again takes its access away. Written
 * straight to the Team Brain state, so the set-up modal and the interview's
 * launch card show the same choices.
 */
export function AgentAccessList({
  agents,
  className,
  rowClassName,
}: {
  agents: readonly ApiAgent[]
  className?: string
  rowClassName?: string
}) {
  const tb = useTeamBrain()
  return (
    <ul className={cn('divide-y divide-border/60', className)} data-testid="team-brain-agent-access">
      {agents.map((agent) => {
        const access = agentAccessOf(tb.state, agent.slug)
        return (
          <li key={agent.slug} className={cn('flex items-center gap-3 py-3', rowClassName)}>
            <AgentAvatar agent={agent} size={22} />
            <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', access === 'none' && 'text-muted-foreground')}>{agent.name}</span>
            <span role="group" aria-label={`${agent.name}’s access`} className="inline-flex shrink-0 rounded-md border bg-background p-0.5">
              {TEAM_BRAIN_ACCESS.map((option) => {
                const on = access === option
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={on}
                    onClick={() => tb.setAgentAccess(agent.slug, on ? 'none' : option)}
                    data-testid={`team-brain-access-${agent.slug}-${option}`}
                    className={cn(
                      'h-6 rounded-[5px] px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      on ? 'bg-brand text-white' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {ACCESS_LABELS[option]}
                  </button>
                )
              })}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
