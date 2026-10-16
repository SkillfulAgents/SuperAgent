import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { startViewTransition } from '@renderer/lib/view-transition'
import { Switch } from '@renderer/components/ui/switch'

export interface AssignmentAgent {
  slug: string
  name: string
  displaySlug: string
}

interface AgentAssignmentListProps {
  agents: AssignmentAgent[]
  assignedSlugs: readonly string[]
  isLoading?: boolean
  error?: Error | null
  sectioned?: boolean
  onToggle: (slug: string, assigned: boolean) => Promise<unknown>
  toggleLabel: (agent: AssignmentAgent, assigned: boolean) => string
  testId: (slug: string) => string
  assignedLabel?: string
  unassignedLabel?: string
  emptyAssigned?: string
  rowDescription?: (agent: AssignmentAgent) => ReactNode
}

/** Shared optimistic assignment list, including row movement and rollback animations. */
export function AgentAssignmentList({
  agents, assignedSlugs, isLoading, error, sectioned = false, onToggle, toggleLabel, testId,
  assignedLabel = 'Agents With Access', unassignedLabel = 'Agents Without Access',
  emptyAssigned = 'No agents have access yet. Grant one below.', rowDescription,
}: AgentAssignmentListProps) {
  const transitionId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const assigned = useMemo(() => new Set(assignedSlugs), [assignedSlugs])
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [pending, setPending] = useState<Set<string>>(new Set())
  const inFlight = useRef(new Set<string>())
  const [mutationError, setMutationError] = useState<string | null>(null)

  useEffect(() => {
    setOverrides(previous => {
      const next = { ...previous }
      let changed = false
      for (const [slug, value] of Object.entries(previous)) {
        if (!pending.has(slug) && assigned.has(slug) === value) { delete next[slug]; changed = true }
      }
      return changed ? next : previous
    })
  }, [assigned, pending])

  const animate = (update: () => void) => {
    if (sectioned) startViewTransition(() => flushSync(update))
    else update()
  }
  const toggle = async (slug: string, next: boolean) => {
    if (inFlight.current.has(slug)) return
    inFlight.current.add(slug)
    setPending(new Set(inFlight.current))
    setMutationError(null)
    animate(() => setOverrides(previous => ({ ...previous, [slug]: next })))
    try {
      await onToggle(slug, next)
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Could not update this agent. Please try again.')
      // Queue rollback after the optimistic transition, even on an immediate rejection.
      animate(() => setOverrides(previous => {
        const result = { ...previous }; delete result[slug]; return result
      }))
    } finally {
      inFlight.current.delete(slug)
      setPending(new Set(inFlight.current))
    }
  }

  if (isLoading) return <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" />Loading agents...</div>
  if (error) return <p role="alert" className="py-4 text-sm text-destructive">{error.message}</p>
  if (agents.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">No agents available.</p>

  const isAssigned = (slug: string) => overrides[slug] ?? assigned.has(slug)
  const row = (agent: AssignmentAgent) => <li key={agent.slug} className="flex items-center gap-3 px-3 py-2.5"
    style={sectioned ? { viewTransitionName: `assignment-${transitionId}-${agent.slug}` } as CSSProperties : undefined}>
    <div className="min-w-0 flex-1">
      <div className="text-xs font-medium truncate">{agent.name}</div>
      <div className="text-[11px] text-muted-foreground truncate">{agent.displaySlug}</div>
      {rowDescription?.(agent)}
    </div>
    {pending.has(agent.slug) ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={`Updating ${agent.name}`} /> : <Switch
      checked={isAssigned(agent.slug)} onCheckedChange={next => { void toggle(agent.slug, next) }}
      aria-label={toggleLabel(agent, isAssigned(agent.slug))} data-testid={testId(agent.slug)} />}
  </li>
  const withAccess = agents.filter(agent => isAssigned(agent.slug))
  const withoutAccess = agents.filter(agent => !isAssigned(agent.slug))
  return <div className="space-y-6">
    {mutationError && <p role="alert" className="text-xs text-destructive">{mutationError}</p>}
    {sectioned ? <>
      <div className="space-y-1.5">
        <p className="text-xs font-normal text-muted-foreground px-1">{assignedLabel}</p>
        {withAccess.length ? <ul className="rounded-xl border bg-background divide-y divide-border/50 overflow-hidden">{withAccess.map(row)}</ul>
          : <div className="rounded-xl border border-dashed bg-background px-4 py-6 text-center"><p className="text-xs text-muted-foreground">{emptyAssigned}</p></div>}
      </div>
      {withoutAccess.length > 0 && <div className="space-y-1.5">
        <p className="text-xs font-normal text-muted-foreground px-1">{unassignedLabel}</p>
        <ul className="rounded-xl border bg-background divide-y divide-border/50 overflow-hidden">{withoutAccess.map(row)}</ul>
      </div>}
    </> : <ul className="divide-y divide-border/50">{agents.map(row)}</ul>}
  </div>
}
