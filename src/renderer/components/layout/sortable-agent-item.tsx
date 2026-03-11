import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import { AgentMenuItem } from './app-sidebar'

export function SortableAgentMenuItem({ agent }: { agent: ApiAgent }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: agent.slug })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
    zIndex: isDragging ? 1 : undefined,
  }

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
