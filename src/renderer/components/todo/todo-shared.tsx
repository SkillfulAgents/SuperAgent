import { useMemo, type ReactNode } from 'react'
import { format, formatDistanceToNowStrict, isToday } from 'date-fns'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { useAgents } from '@renderer/hooks/use-agents'

export interface TodoAgent {
  slug: string
  name: string
}

/** The agents on this install the person can hand work to, by slug. */
export function useTodoAgents(): { agents: TodoAgent[]; bySlug: Map<string, TodoAgent> } {
  const { data } = useAgents()
  return useMemo(() => {
    const agents = (data ?? []).map((a) => ({ slug: a.slug, name: a.name }))
    return { agents, bySlug: new Map(agents.map((a) => [a.slug, a])) }
  }, [data])
}

/** Pick the agent a draft goes to. */
export function AgentPicker({ agents, selected, onPick, trigger }: {
  agents: TodoAgent[]
  selected: string | null
  onPick: (agent: TodoAgent) => void
  trigger: ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-56 overflow-y-auto">
        {agents.length === 0 && <DropdownMenuItem disabled>No agents yet</DropdownMenuItem>}
        <DropdownMenuRadioGroup
          value={selected ?? ''}
          onValueChange={(slug) => {
            const agent = agents.find((a) => a.slug === slug)
            if (agent) onPick(agent)
          }}
        >
          {agents.map((agent) => (
            <DropdownMenuRadioItem key={agent.slug} value={agent.slug} data-testid={`todo-agent-option-${agent.slug}`}>
              <span className="truncate">{agent.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Linear-style compact age for a card's metadata row: "now", "8m", "3h", "2d", then a date. */
export function ago(ts: number): string {
  const minutes = Math.floor((Date.now() - ts) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`
  return format(ts, 'MMM d')
}

/** A spelled-out "edited" time for drafts: "just now", "5 minutes ago", then a date. */
export function when(ts: number): string {
  if (Date.now() - ts < 60_000) return 'just now'
  return isToday(ts) ? formatDistanceToNowStrict(ts, { addSuffix: true }) : format(ts, 'MMM d')
}
