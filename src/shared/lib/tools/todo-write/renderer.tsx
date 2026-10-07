import { defineToolRenderer } from '../renderer-types'
import { SquareCheck } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { todoWriteDef } from './definition'
import { TaskStatusIcon } from '../ui/shared'
import type { ToolRendererProps } from '../renderer-types'

function ExpandedView({ input }: ToolRendererProps) {
  const { todos } = todoWriteDef.parseInput(input)

  if (!todos || !Array.isArray(todos) || todos.length === 0) {
    return <div className="text-xs text-muted-foreground italic">No items</div>
  }

  return (
    <ul className="space-y-1 text-xs">
      {todos.map((todo, index) => (
        <li
          key={index}
          className={cn(
            'flex items-center gap-2',
            todo.status === 'completed' && 'text-muted-foreground line-through',
            todo.status === 'in_progress' && 'font-medium'
          )}
        >
          <TaskStatusIcon status={todo.status} />
          {todo.content}
        </li>
      ))}
    </ul>
  )
}

export const todoWriteRenderer = defineToolRenderer(todoWriteDef, {
  icon: SquareCheck,
  ExpandedView,
})
