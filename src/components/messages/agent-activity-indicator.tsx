'use client'

import { useMessages } from '@/lib/hooks/use-messages'
import { useMessageStream } from '@/lib/hooks/use-message-stream'
import { cn } from '@/lib/utils'

interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

interface AgentActivityIndicatorProps {
  sessionId: string
}

export function AgentActivityIndicator({ sessionId }: AgentActivityIndicatorProps) {
  const { isActive } = useMessageStream(sessionId)
  const { data: messages } = useMessages(sessionId)

  // Don't render if not active
  if (!isActive) {
    return null
  }

  // Find the most recent TodoWrite tool call
  let todos: Todo[] | null = null
  let activeItem: Todo | null = null

  if (messages) {
    // Iterate through messages in reverse to find the most recent TodoWrite
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.toolCalls) {
        for (let j = message.toolCalls.length - 1; j >= 0; j--) {
          const toolCall = message.toolCalls[j]
          if (toolCall.name === 'TodoWrite') {
            try {
              const input = toolCall.input as { todos?: Todo[] }
              if (input?.todos && Array.isArray(input.todos)) {
                todos = input.todos
                activeItem = todos.find((t) => t.status === 'in_progress') || null
                break
              }
            } catch {
              // Invalid input format, skip
            }
          }
        }
        if (todos) break
      }
    }
  }

  const statusText = activeItem?.activeForm || 'Working...'

  return (
    <div className="mx-4 mb-2 rounded-lg border bg-muted/50 p-3">
      {/* Header with pulsing indicator */}
      <div className="flex items-center gap-2">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span>
        </span>
        <span className="text-sm font-medium">{statusText}</span>
      </div>

      {/* Todo list if available */}
      {todos && todos.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
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
      )}
    </div>
  )
}
