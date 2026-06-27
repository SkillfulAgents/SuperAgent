
import { useState, useRef, useMemo, useEffect } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { ChevronDown, ChevronRight, Workflow } from 'lucide-react'
import { StreamingToolCallItem, StatusIndicator } from './tool-call-item'
import { flattenAssistantMessages, TranscriptItems, TranscriptText, type FlatItem } from './agent-transcript'
import { useSubagentMessages } from '@renderer/hooks/use-messages'
import { parseToolResult } from '@renderer/lib/parse-tool-result'
import type { ApiToolCall, ApiMessage } from '@shared/lib/types/api'
import type { SubagentInfo } from '@renderer/hooks/use-message-stream'
import { formatElapsed } from '@renderer/hooks/use-elapsed-timer'

const SUBAGENT_LABEL_CLASS =
  'font-sans font-normal shrink-0 text-sm text-foreground/65 group-hover:text-foreground leading-none transition-colors'

interface SubAgentBlockProps {
  toolCall: ApiToolCall
  sessionId: string
  agentSlug: string
  isSessionActive?: boolean
  activeSubagent?: SubagentInfo | null
  isCompleted?: boolean // True when subagent_completed SSE has fired for this tool (avoids JSONL stale status)
}

type SubagentStatus = 'running' | 'completed' | 'error' | 'cancelled'

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return `${tokens}`
}

export function SubAgentBlock({
  toolCall,
  sessionId,
  agentSlug,
  isSessionActive,
  activeSubagent,
  isCompleted,
}: SubAgentBlockProps) {
  // Determine subagent ID: prefer SSE-discovered agentId (stable, cached once via FIFO)
  // over API-based agentId (from resolveInterruptedSubagents, which re-sorts by mtime
  // on every refetch and can flip during active streaming).
  // Latch the ID once resolved — it should never revert to null.
  const sseAgentId = activeSubagent?.parentToolId === toolCall.id ? activeSubagent.agentId : null
  const computedSubagentId = sseAgentId
    ?? toolCall.subagent?.agentId
    ?? null
  const latchedSubagentIdRef = useRef<string | null>(null)
  if (computedSubagentId) {
    latchedSubagentIdRef.current = computedSubagentId
  }
  const subagentId = computedSubagentId ?? latchedSubagentIdRef.current

  // Determine status
  let status: SubagentStatus = 'cancelled'
  if (toolCall.result !== null && toolCall.result !== undefined) {
    // Background agents return an immediate "async_launched" result — don't treat as completed
    // unless we've received a subagent_completed SSE event (isCompleted) for this tool
    if (toolCall.subagent?.status === 'async_launched' && isSessionActive && !isCompleted) {
      status = 'running'
    } else {
      status = toolCall.isError ? 'error' : 'completed'
    }
  } else if (isCompleted) {
    // subagent_completed SSE received but tool_result not yet persisted/refetched
    status = 'completed'
  } else if (isSessionActive && (activeSubagent?.parentToolId === toolCall.id || !toolCall.subagent)) {
    status = 'running'
  }

  const isRunning = status === 'running'
  const [expanded, setExpanded] = useState(isRunning)

  // Fetch subagent messages — poll while running so concurrent background agents stay updated
  const { data: subMessages } = useSubagentMessages(sessionId, agentSlug, subagentId)

  // Extract streaming state from activeSubagent (only if this block is the active one)
  const isActiveSubagent = activeSubagent?.parentToolId === toolCall.id
  const subagentStreamingMessage = isActiveSubagent ? activeSubagent?.streamingMessage : null
  const subagentStreamingToolUse = isActiveSubagent ? activeSubagent?.streamingToolUse : null

  // Auto-expand when streaming content arrives
  useEffect(() => {
    if (isActiveSubagent && (subagentStreamingMessage || subagentStreamingToolUse)) {
      setExpanded(true)
    }
  }, [isActiveSubagent, subagentStreamingMessage, subagentStreamingToolUse])

  // Check if streaming text is already persisted (same dedup pattern as main agent)
  const isStreamingMessagePersisted = useMemo(() => {
    if (!subagentStreamingMessage || !subMessages?.length) return false
    const assistantMessages = subMessages.filter(
      (m): m is ApiMessage => m.type === 'assistant'
    )
    if (assistantMessages.length === 0) return false
    const lastAssistant = assistantMessages[assistantMessages.length - 1]
    const persistedText = lastAssistant.content.text?.trim() || ''
    const streamingText = subagentStreamingMessage.trim()
    if (!persistedText || !streamingText) return false
    return persistedText.startsWith(streamingText) || streamingText.startsWith(persistedText)
  }, [subMessages, subagentStreamingMessage])

  // Check if streaming tool use is already persisted
  const isStreamingToolUsePersisted = useMemo(() => {
    if (!subagentStreamingToolUse || !subMessages?.length) return false
    return subMessages.some(m =>
      m.type === 'assistant' &&
      (m as ApiMessage).toolCalls?.some(tc => tc.id === subagentStreamingToolUse.id)
    )
  }, [subMessages, subagentStreamingToolUse])

  // Extract display info — prefer live SSE data (available immediately from task_started),
  // fall back to tool_use input (available once the tool call is fully streamed)
  const input = toolCall.input as { subagent_type?: string; description?: string }
  const subagentType = activeSubagent?.subagentType || input.subagent_type || 'Agent'
  const description = activeSubagent?.description || input.description || ''

  // Extract summary text — prefer persisted tool_result, fall back to SSE-delivered resultText
  const resultText = useMemo(() => {
    if (toolCall.result != null) {
      const parsed = parseToolResult(toolCall.result)
      return parsed.text
    }
    if (isActiveSubagent && activeSubagent?.resultText) {
      return activeSubagent.resultText
    }
    return null
  }, [toolCall.result, isActiveSubagent, activeSubagent?.resultText])

  // Stats from completed subagent
  const stats = toolCall.subagent

  // Flatten assistant messages into individual renderable items (text blocks + tool calls)
  const flatItems = useMemo<FlatItem[]>(() => flattenAssistantMessages(subMessages), [subMessages])

  // Check if the result text is already present in the persisted flat items (dedup)
  const isResultInFlatItems = useMemo(() => {
    if (!resultText || !flatItems.length) return false
    const lastTextItem = [...flatItems].reverse().find(i => i.kind === 'text')
    if (!lastTextItem || lastTextItem.kind !== 'text') return false
    const persistedText = lastTextItem.text.trim()
    const result = resultText.trim()
    return persistedText.includes(result) || result.includes(persistedText)
  }, [resultText, flatItems])

  const DEFAULT_VISIBLE = 6
  const [showAll, setShowAll] = useState(false)
  const totalItems = flatItems.length
  const hasMore = totalItems > DEFAULT_VISIBLE
  const visibleItems = showAll || !hasMore
    ? flatItems
    : flatItems.slice(totalItems - DEFAULT_VISIBLE)

  const hasStreamingContent = !!(subagentStreamingMessage && !isStreamingMessagePersisted)
    || !!(subagentStreamingToolUse && !isStreamingToolUsePersisted)

  return (
    <div className="text-sm border border-border/70 rounded-md overflow-hidden">
      {/* Header — matches ToolCallItem collapsed row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn('flex w-full items-center gap-2 pl-2 pr-2 py-1.5 group hover:bg-muted/50 transition-colors', expanded && 'bg-muted/50')}
      >
        <Workflow className="h-3.5 w-3.5 shrink-0 text-foreground/45 group-hover:text-foreground transition-colors" />
        <span className={SUBAGENT_LABEL_CLASS}>Sub-agent:</span>
        <span className={SUBAGENT_LABEL_CLASS}>
          {subagentType}
        </span>
        {description && (
          <>
            <span aria-hidden className="shrink-0 text-foreground/40 group-hover:text-muted-foreground text-sm leading-none transition-colors">→</span>
            <span className="text-muted-foreground/70 group-hover:text-muted-foreground truncate text-xs leading-none transition-colors">
              {description}
            </span>
          </>
        )}
        <span className="relative ml-auto flex h-4 w-4 shrink-0 items-center justify-center">
          <span className="transition-opacity group-hover:opacity-0">
            <StatusIndicator status={status} />
          </span>
          <span className="absolute inset-0 flex items-center justify-center text-muted-foreground/60 opacity-0 transition-opacity group-hover:text-muted-foreground group-hover:opacity-100">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
        </span>
      </button>

      {/* Body - subagent messages */}
      {expanded && (
        <div className="border-t border-border/70 bg-muted/50 px-3 py-3">
          <div className="space-y-3">
            {totalItems === 0 && isRunning && !hasStreamingContent && (
              <div className="text-xs text-muted-foreground italic py-2">
                Sub-agent is working...
              </div>
            )}
            {totalItems === 0 && !isRunning && !subagentId && (
              <div className="text-xs text-muted-foreground italic py-2">
                No sub-agent messages available
              </div>
            )}

            {/* Show all button */}
            {hasMore && !showAll && (
              <button
                onClick={() => setShowAll(true)}
                className="text-xs text-foreground hover:text-foreground/70 font-medium transition-colors py-1"
              >
                Show all ({totalItems} items)
              </button>
            )}

            <TranscriptItems items={visibleItems} agentSlug={agentSlug} isSessionActive={isSessionActive} />

            {/* Streaming text from subagent (not yet persisted) */}
            {subagentStreamingMessage && !isStreamingMessagePersisted && (
              <TranscriptText>{subagentStreamingMessage}</TranscriptText>
            )}

            {/* Streaming tool use from subagent (not yet persisted) */}
            {subagentStreamingToolUse && !isStreamingToolUsePersisted && (
              <StreamingToolCallItem
                name={subagentStreamingToolUse.name}
                partialInput={subagentStreamingToolUse.partialInput}
              />
            )}

            {/* Result summary from tool_result (available immediately, no JSONL refetch needed) */}
            {resultText && !isResultInFlatItems && !isRunning && (
              <TranscriptText>{resultText}</TranscriptText>
            )}
          </div>

          {/* Stats footer — show live usage while running, final stats when completed */}
          {stats && status !== 'running' && (
            <div className="mt-2 text-xs text-muted-foreground italic">
              {stats.totalDurationMs != null && formatElapsed(stats.totalDurationMs)}
              {stats.totalTokens != null && (
                <>{stats.totalDurationMs != null && ' · '}{formatTokens(stats.totalTokens)} tokens</>
              )}
              {stats.totalToolUseCount != null && (
                <> · {stats.totalToolUseCount} tool call{stats.totalToolUseCount !== 1 ? 's' : ''}</>
              )}
            </div>
          )}
          {isRunning && isActiveSubagent && activeSubagent?.usage && (
            <div className="mt-2 text-xs text-muted-foreground italic">
              {formatElapsed(activeSubagent.usage.duration_ms)}
              {' · '}{formatTokens(activeSubagent.usage.total_tokens)} tokens
              {' · '}{activeSubagent.usage.tool_uses} tool call{activeSubagent.usage.tool_uses !== 1 ? 's' : ''}
              {activeSubagent.lastToolName && (
                <> · <span className="font-mono">{activeSubagent.lastToolName}</span></>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
