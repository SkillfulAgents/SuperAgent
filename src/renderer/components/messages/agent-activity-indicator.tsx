
import { useMessages } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useElapsedTimer } from '@renderer/hooks/use-elapsed-timer'
import { apiFetch } from '@renderer/lib/api'
import { cn } from '@shared/lib/utils'
import { AlertTriangle, Monitor, X } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

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
  const {
    isActive, error, activeStartTime, isCompacting, activeSubagents, completedSubagents,
    pendingSecretRequests, pendingConnectedAccountRequests, pendingQuestionRequests,
    pendingFileRequests, pendingRemoteMcpRequests, pendingBrowserInputRequests,
    apiRetry, computerUseApp, computerUseAppIcon,
  } = useMessageStream(sessionId, agentSlug)

  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState(false)
  const handleRevokeComputerUse = useCallback(async () => {
    setRevoking(true)
    setRevokeError(false)
    try {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/computer-use/revoke`, { method: 'POST' })
      if (!res.ok) throw new Error()
    } catch {
      setRevokeError(true)
    } finally {
      setRevoking(false)
    }
  }, [agentSlug, sessionId])

  const isAwaitingInput = isActive && (
    pendingSecretRequests.length > 0 ||
    pendingConnectedAccountRequests.length > 0 ||
    pendingQuestionRequests.length > 0 ||
    pendingFileRequests.length > 0 ||
    pendingRemoteMcpRequests.length > 0 ||
    pendingBrowserInputRequests.length > 0
  )
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

  // Collect subagent display info by matching activeSubagents (SSE-tracked) with tool calls in messages
  const subagentItems = useMemo(() => {
    if (!messages || activeSubagents.length === 0) return []
    const activeMap = new Map(activeSubagents.map(s => [s.parentToolId, s]))
    const items: { id: string; name: string; description: string; status: 'running' | 'completed'; progressSummary: string | null }[] = []
    for (const msg of messages) {
      if (msg.type === 'compact_boundary') continue
      for (const tc of msg.toolCalls || []) {
        if ((tc.name === 'Agent' || tc.name === 'Task') && activeMap.has(tc.id)) {
          if (tc.isError) continue
          const input = tc.input as { subagent_type?: string; description?: string }
          const isCompleted = completedSubagents?.has(tc.id) || tc.result != null
          const sub = activeMap.get(tc.id)
          items.push({
            id: tc.id,
            name: input.subagent_type || tc.name,
            description: input.description || '',
            status: isCompleted ? 'completed' : 'running',
            progressSummary: sub?.progressSummary ?? null,
          })
        }
      }
    }
    return items
  }, [messages, activeSubagents, completedSubagents])

  // Show error if present
  if (error) {
    return (
      <div className="mx-auto mb-2 w-full max-w-[740px] px-4">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <span className="text-sm font-medium text-destructive">Error</span>
          </div>
          <p className="mt-1 text-sm text-destructive/90">{error}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Send another message to retry.
          </p>
        </div>
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
      if (message.type === 'compact_boundary') continue
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

  const statusText = isAwaitingInput
    ? 'Waiting for input...'
    : isCompacting
      ? 'Compacting...'
      : apiRetry
        ? `Retrying... (attempt ${apiRetry.attempt}${apiRetry.maxRetries ? `/${apiRetry.maxRetries}` : ''})`
        : (activeItem?.activeForm || 'Working...')

  return (
    <div className="mx-auto mb-2 w-full max-w-[740px] px-4">
      <div className="rounded-lg border bg-muted/50 p-3" data-testid="activity-indicator">
        {/* Header with pulsing indicator */}
        <div className="flex items-center gap-2">
          <span className="relative flex h-3 w-3">
            <span className={cn(
              "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
              (isAwaitingInput || apiRetry) ? "bg-orange-500" : "bg-primary"
            )}></span>
            <span className={cn(
              "relative inline-flex rounded-full h-3 w-3",
              (isAwaitingInput || apiRetry) ? "bg-orange-500" : "bg-primary"
            )}></span>
          </span>
          <span className="text-sm font-medium">{statusText}</span>
          {computerUseApp && (
            <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300">
              {computerUseAppIcon ? (
                <img src={`data:image/png;base64,${computerUseAppIcon}`} alt="" className="h-4 w-4" />
              ) : (
                <Monitor className="h-3 w-3" />
              )}
              {computerUseApp}
              <button
                onClick={handleRevokeComputerUse}
                disabled={revoking}
                className={cn(
                  "ml-0.5 rounded-full p-0.5 transition-colors cursor-pointer",
                  revokeError ? "bg-red-200 dark:bg-red-800" : "hover:bg-blue-200 dark:hover:bg-blue-800"
                )}
                title={revokeError ? "Failed to revoke — click to retry" : "Release app and revoke permission"}
              >
                <X className={cn("h-3 w-3", revokeError && "text-red-600 dark:text-red-400")} />
              </button>
            </span>
          )}
          {elapsed && (
            <span className="text-xs text-muted-foreground tabular-nums">{elapsed}</span>
          )}
        </div>

        {/* Active subagents */}
        {subagentItems.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm pl-5">
            {subagentItems.map((item) => (
              <li key={item.id} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  {item.status === 'running' ? (
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                    </span>
                  ) : (
                    <span className="text-xs text-green-500 shrink-0">✓</span>
                  )}
                  <span className={cn(
                    'font-mono text-xs',
                    item.status === 'completed' && 'text-muted-foreground'
                  )}>
                    {item.name}
                  </span>
                  {item.description && (
                    <span className="text-xs text-muted-foreground truncate">
                      {item.description}
                    </span>
                  )}
                </div>
                {item.progressSummary && item.status === 'running' && (
                  <span className="text-xs text-muted-foreground ml-4 italic">
                    {item.progressSummary}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

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
    </div>
  )
}
