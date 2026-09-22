import { useMemo } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import { AgentMenuItem } from './app-sidebar'

/**
 * The thin sortable shell around a heavy row. dnd-kit re-renders every
 * `useSortable` consumer on each drag tick (its internal context carries the
 * live `over` state), so this component is deliberately nothing but the hook
 * and prop plumbing: `AgentMenuItem` is memoized and every prop handed to it
 * here is referentially stable across those ticks, which is what lets the
 * heavy subtree skip the churn. Keep it that way — an inline object or
 * closure prop added here would silently defeat the memo.
 */
export function SortableAgentMenuItem({ agent }: { agent: ApiAgent }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.slug, data: { type: 'agent', slug: agent.slug } })

  // CSS.Transform.toString collapses the transform object to a string, so the
  // memo key is by value: rows the current tick did not displace keep a stable
  // style object even though useSortable handed back a fresh transform object.
  const transformString = CSS.Transform.toString(transform)
  const style = useMemo(
    () => ({
      transform: transformString,
      transition,
      opacity: isDragging ? 0.4 : undefined,
      zIndex: isDragging ? 1 : undefined,
    }),
    [transformString, transition, isDragging]
  )

  return (
    <AgentMenuItem
      ref={setNodeRef}
      style={style}
      agent={agent}
      {...attributes}
      {...listeners}
    />
  )
}
