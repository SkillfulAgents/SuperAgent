
import { useMessages } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useElapsedTimer } from '@renderer/hooks/use-elapsed-timer'
import { usePendingProxyReviews } from '@renderer/hooks/use-proxy-reviews'
import { apiFetch } from '@renderer/lib/api'
import { ProviderErrorCard } from '@renderer/components/ui/provider-error-card'
import { InsufficientBalanceCard, usePlatformBillingUrl } from './insufficient-balance-card'
import { PROVIDER_ERROR_CODES } from '@shared/lib/types/api'
import { isTurnStartingUserMessage } from './pending-message'
import { cn } from '@shared/lib/utils'
import { AlertTriangle, Monitor, X } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { deriveTaskList, Todo } from '@shared/lib/utils/derive-task-list'

interface AgentActivityIndicatorProps {
  sessionId: string
  agentSlug: string
}

export function AgentActivityIndicator({ sessionId, agentSlug }: AgentActivityIndicatorProps) {
  const {
    isActive, error, apiErrorCode, activeStartTime, isCompacting, activeSubagents, completedSubagents,
    pendingSecretRequests, pendingConnectedAccountRequests, pendingQuestionRequests,
    pendingFileRequests, pendingRemoteMcpRequests, pendingBrowserInputRequests,
    apiRetry, computerUseApp, computerUseAppIcon, backgroundTasks,
    isThinking,
  } = useMessageStream(sessionId, agentSlug)
  const { data: proxyReviewsData } = usePendingProxyReviews(agentSlug)
  const pendingProxyReviewCount = proxyReviewsData?.reviews?.length ?? 0

  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState(false)
  const [showAllTodos, setShowAllTodos] = useState(false)

  // Non-null only for a platform billing 402 the workspace can act on (see hook).
  const billingUrl = usePlatformBillingUrl(error ?? '')

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
    pendingBrowserInputRequests.length > 0 ||
    pendingProxyReviewCount > 0
  )
  const { data: messages } = useMessages(sessionId, agentSlug)

  // Use activeStartTime from SSE (set when session_active fires) as primary source.
  // Falls back to last persisted user message timestamp (for page refresh recovery).
  // Queued (mid-turn) messages don't start a turn — skipping them keeps the
  // elapsed timer anchored to the turn-starting prompt after a refresh.
  const timerStartTime = useMemo(() => {
    if (activeStartTime) return new Date(activeStartTime)
    if (!messages) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isTurnStartingUserMessage(messages[i])) {
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
      if (msg.type !== 'user' && msg.type !== 'assistant') continue
      for (const tc of msg.toolCalls || []) {
        if ((tc.name === 'Agent' || tc.name === 'Task') && activeMap.has(tc.id)) {
          if (tc.isError) continue
          const input = tc.input as { subagent_type?: string; description?: string }
          // A background agent returns an immediate "async_launched" tool result
          // — that's the launch ack, NOT completion. It only finishes when the
          // sidechain result fires the subagent_completed SSE (completedSubagents).
          // Foreground agents complete when their tool result lands. (Mirrors
          // subagent-block.tsx so the activity block and the thread block agree.)
          const isAsyncLaunched = tc.subagent?.status === 'async_launched'
          const isCompleted = (completedSubagents?.has(tc.id) ?? false) || (!isAsyncLaunched && tc.result != null)
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

  // Derive the todo/task list from TaskCreate/TaskUpdate (newer SDK) or fall back
  // to TodoWrite (older SDK). Memoized on [messages] so it doesn't re-scan the
  // whole transcript on every per-delta re-render driven by useMessageStream —
  // only when the persisted message list actually changes.
  const { todos, activeItem } = useMemo<{ todos: Todo[] | null; activeItem: Todo | null }>(
    () => deriveTaskList(messages),
    [messages]
  )

  // Show error if present
  if (error) {
    const isProviderError = apiErrorCode != null && PROVIDER_ERROR_CODES.has(apiErrorCode)
    return (
      <div className="mx-auto mb-2 w-full max-w-[740px] px-4">
        {billingUrl ? (
          <InsufficientBalanceCard billingUrl={billingUrl} data-testid="insufficient-balance-card" />
        ) : isProviderError ? (
          <ProviderErrorCard message={error} data-testid="provider-error-card" />
        ) : (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 select-text" data-testid="error-card">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <span className="text-sm font-medium text-destructive">Error</span>
            </div>
            <p className="mt-1 text-sm text-destructive/90">{error}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Send another message to retry.
            </p>
          </div>
        )}
      </div>
    )
  }

  // Don't render if not active
  if (!isActive) {
    return null
  }

  const statusText = isAwaitingInput
    ? 'Waiting for input...'
    : isCompacting
      ? 'Compacting...'
      : apiRetry
        ? `Retrying... (attempt ${apiRetry.attempt}${apiRetry.maxRetries ? `/${apiRetry.maxRetries}` : ''})`
        : isThinking
          ? 'Thinking...'
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

        {/* Streamed reasoning renders as a thinking card in the transcript
            (see ThinkingBlockItem) — only the "Thinking..." status shows here. */}

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

        {/* Active background processes. Background subagents are excluded: they
            already render as named subagent rows above, and counting them here
            would show the same work twice. */}
        {backgroundTasks.some((t) => !t.isSubagent) && (
          <BackgroundTasksSection tasks={backgroundTasks.filter((t) => !t.isSubagent)} />
        )}

        {/* Todo list if available and at least one item is not completed */}
        {todos && todos.length > 0 && todos.some((t) => t.status !== 'completed') && (() => {
          const MAX_VISIBLE = 5
          const needsTruncation = todos.length > MAX_VISIBLE && !showAllTodos

          const notDone = todos.filter(t => t.status !== 'completed')
          const doneReversed = todos.filter(t => t.status === 'completed').reverse()

          let visibleTodos: Todo[]
          let hiddenTodos: Todo[]

          if (!needsTruncation) {
            visibleTodos = [...notDone, ...doneReversed]
            hiddenTodos = []
          } else {
            const visibleNotDone = notDone.slice(0, MAX_VISIBLE)
            const remainingSlots = MAX_VISIBLE - visibleNotDone.length
            const visibleDone = doneReversed.slice(0, remainingSlots)
            visibleTodos = [...visibleNotDone, ...visibleDone]
            const visibleSet = new Set(visibleTodos)
            hiddenTodos = todos.filter(t => !visibleSet.has(t))
          }

          const hiddenPending = hiddenTodos.filter(t => t.status !== 'completed').length
          const hiddenDone = hiddenTodos.filter(t => t.status === 'completed').length

          return (
            <ul className="mt-2 space-y-1 text-sm">
              {hiddenTodos.length > 0 && (
                <li>
                  <button
                    onClick={() => setShowAllTodos(true)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  >
                    {hiddenTodos.length} more{': '}
                    {[
                      hiddenPending > 0 && `${hiddenPending} pending`,
                      hiddenDone > 0 && `${hiddenDone} done`,
                    ].filter(Boolean).join(', ')}
                  </button>
                </li>
              )}
              {showAllTodos && todos.length > MAX_VISIBLE && (
                <li>
                  <button
                    onClick={() => setShowAllTodos(false)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                  >
                    Show fewer
                  </button>
                </li>
              )}
              {visibleTodos.map((todo, index) => (
                <li
                  key={index}
                  className={cn(
                    'flex items-center gap-2',
                    todo.status === 'completed' && 'text-muted-foreground line-through',
                    todo.status === 'in_progress' && 'font-medium'
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
        })()}
      </div>
    </div>
  )
}

function BackgroundTasksSection({ tasks }: { tasks: Array<{ taskId: string; startedAt: number; isWorkflow?: boolean; isSubagent?: boolean }> }) {
  const earliest = Math.min(...tasks.map(t => t.startedAt))
  const elapsed = useElapsedTimer(new Date(earliest))
  // Label as "workflow" when every active background task is a dynamic workflow;
  // fall back to the generic "process" wording for backgrounded Bash (or a mix).
  const allWorkflows = tasks.every(t => t.isWorkflow)
  const noun = allWorkflows ? 'workflow' : 'process'
  const label = `${tasks.length} background ${tasks.length === 1 ? noun : allWorkflows ? `${noun}s` : `${noun}es`}`
  return (
    <div className="mt-2 text-sm pl-5">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
        </span>
        <span className="text-xs text-muted-foreground">
          {label}
        </span>
        {elapsed && (
          <span className="text-xs text-muted-foreground tabular-nums">{elapsed}</span>
        )}
      </div>
    </div>
  )
}
