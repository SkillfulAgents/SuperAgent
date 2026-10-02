import { useMemo, type ReactNode } from 'react'
import { format, formatDistanceToNowStrict, isToday } from 'date-fns'
import { cn } from '@shared/lib/utils/cn'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { useAgents } from '@renderer/hooks/use-agents'

export interface TodoAgent {
  slug: string
  name: string
}

const GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ['#5b8def', '#8f6bff'],
  ['#ff8a5b', '#ff5b8d'],
  ['#2fbf9f', '#5b8def'],
  ['#f2b134', '#ff7a59'],
  ['#8f6bff', '#e05bff'],
  ['#3ac7e8', '#2fbf9f'],
]

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h
}

function agentInitials(name: string): string {
  // Words that start with a letter or digit; an emoji or symbol prefix is
  // decoration, not a name.
  const parts = name
    .trim()
    .split(/\s+/)
    .map((w) => Array.from(w).filter((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter((w) => w.length > 0)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).join('').toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/** Small round identity mark for an agent. Colour is hashed from the slug. */
export function TodoAgentAvatar({ agent, size = 20, className }: { agent: TodoAgent; size?: number; className?: string }) {
  const [from, to] = GRADIENTS[hashString(agent.slug) % GRADIENTS.length]
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white', className)}
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.42), background: `linear-gradient(145deg, ${from}, ${to})` }}
    >
      {agentInitials(agent.name)}
    </span>
  )
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
        <DropdownMenuLabel className="text-xs">Give it to</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {agents.length === 0 && <DropdownMenuItem disabled>No agents yet</DropdownMenuItem>}
        {agents.map((agent) => (
          <DropdownMenuItem
            key={agent.slug}
            onSelect={() => onPick(agent)}
            className={cn('gap-2', agent.slug === selected && 'bg-accent')}
            data-testid={`todo-agent-option-${agent.slug}`}
          >
            <TodoAgentAvatar agent={agent} size={18} />
            <span className="truncate">{agent.name}</span>
          </DropdownMenuItem>
        ))}
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
