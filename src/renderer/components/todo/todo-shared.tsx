import { useMemo } from 'react'
import { format, formatDistanceToNowStrict, isToday } from 'date-fns'
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
