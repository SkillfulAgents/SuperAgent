
import { ListTodo } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import type { ToolRenderer, ToolRendererProps } from './types'

interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

interface TodoWriteInput {
  todos?: Todo[]
}

function parseTodoWriteInput(input: unknown): TodoWriteInput {
  if (typeof input === 'object' && input !== null) {
    return input as TodoWriteInput
  }
  return {}
}

function getSummary(input: unknown): string | null {
  const { todos } = parseTodoWriteInput(input)
  if (!todos || !Array.isArray(todos)) return null
  return `Updated ${todos.length} todo item${todos.length !== 1 ? 's' : ''}`
}

function ExpandedView({ input }: ToolRendererProps) {
  const { todos } = parseTodoWriteInput(input)

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
  displayName: 'Todo List',
  icon: ListTodo,
  getSummary,
  ExpandedView,
}
