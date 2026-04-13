
import { ListTodo } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { todoWriteDef } from '@shared/lib/tool-definitions/todo-write'
import type { ToolRenderer, ToolRendererProps } from './types'

function ExpandedView({ input }: ToolRendererProps) {
  const { todos } = todoWriteDef.parseInput(input)

  if (!todos || !Array.isArray(todos) || todos.length === 0) {
    return <div className="text-xs text-muted-foreground italic">No items</div>
  }

  return (
    <ul className="space-y-1 text-sm">
      {todos.map((todo, index) => (
        <li
          key={index}
          className={cn(
            'flex items-center gap-2',
            todo.status === 'completed' && 'text-muted-foreground line-through',
            todo.status === 'in_progress' && 'font-semibold'
          )}
        >
          <span className="text-xs">
            {todo.status === 'completed' && '✓'}
            {todo.status === 'in_progress' && '→'}
            {todo.status === 'pending' && '○'}
          </span>
          {todo.content}
        </li>
      ))}
    </ul>
  )
}

export const todoWriteRenderer: ToolRenderer = {
  displayName: todoWriteDef.displayName,
  icon: ListTodo,
  getSummary: todoWriteDef.getSummary,
  ExpandedView,
}
