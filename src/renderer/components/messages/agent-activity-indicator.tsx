
import { useMessages } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useElapsedTimer } from '@renderer/hooks/use-elapsed-timer'
import { cn } from '@shared/lib/utils'
import { AlertTriangle } from 'lucide-react'
import { useMemo } from 'react'

interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

interface AgentActivityIndicatorProps {
  sessionId: string
  agentSlug: string
}

export function AgentActivityIndicator({ sessionId, agentSlug }: AgentActivityIndicatorProps) {
  const { isActive, error, activeStartTime } = useMessageStream(sessionId, agentSlug)
  const { data: messages } = useMessages(sessionId, agentSlug)

  // Use activeStartTime from SSE (set when session_active fires) as primary source.
  // Falls back to last persisted user message timestamp (for page refresh recovery).
  const timerStartTime = useMemo(() => {
    if (activeStartTime) return new Date(activeStartTime)
    if (!messages) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user') {
        return new Date(messages[i].createdAt)
      }
    }
    return null
  }, [activeStartTime, messages])

  const elapsed = useElapsedTimer(isActive ? timerStartTime : null)

  // Show error if present
  if (error) {
    return (
      <div className="mx-4 mb-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <span className="text-sm font-medium text-destructive">Error</span>
        </div>
        <p className="mt-1 text-sm text-destructive/90">{error}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Send another message to retry.
        </p>
      </div>
    )
  }

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
      // Use the toolCalls array from the API message
      const toolCalls = message.toolCalls || []
      for (let j = toolCalls.length - 1; j >= 0; j--) {
        const toolCall = toolCalls[j]
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

  const statusText = activeItem?.activeForm || 'Working...'

  return (
    <div className="mx-4 mb-2 rounded-lg border bg-muted/50 p-3" data-testid="activity-indicator">
      {/* Header with pulsing indicator */}
      <div className="flex items-center gap-2">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span>
        </span>
        <span className="text-sm font-medium">{statusText}</span>
        {elapsed && (
          <span className="text-xs text-muted-foreground tabular-nums">{elapsed}</span>
        )}
      </div>

      {/* Todo list if available and at least one item is not completed */}
      {todos && todos.length > 0 && todos.some((t) => t.status !== 'completed') && (
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
