
import { useState, useMemo, useEffect } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { Bot, ChevronDown, ChevronRight, CheckCircle, XCircle, Loader2, StopCircle } from 'lucide-react'
import { ToolCallItem, StreamingToolCallItem } from './tool-call-item'
import { useSubagentMessages } from '@renderer/hooks/use-messages'
import type { ApiToolCall, ApiMessage } from '@shared/lib/types/api'
import type { SubagentInfo } from '@renderer/hooks/use-message-stream'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface SubAgentBlockProps {
  toolCall: ApiToolCall
  sessionId: string
  agentSlug: string
  isSessionActive?: boolean
  activeSubagent?: SubagentInfo | null
}

type SubagentStatus = 'running' | 'completed' | 'error' | 'cancelled'

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

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
}: SubAgentBlockProps) {
  // Determine subagent ID from completed result or active SSE state
  const subagentId = toolCall.subagent?.agentId
    ?? (activeSubagent?.parentToolId === toolCall.id ? activeSubagent.agentId : null)
    ?? null

  // Determine status
  let status: SubagentStatus = 'cancelled'
  if (toolCall.result !== null && toolCall.result !== undefined) {
    status = toolCall.isError ? 'error' : 'completed'
  } else if (isSessionActive && (activeSubagent?.parentToolId === toolCall.id || !toolCall.subagent)) {
    status = 'running'
  }

  const isRunning = status === 'running'
  const [expanded, setExpanded] = useState(isRunning)

  // Fetch subagent messages
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

  // Extract display info from input
  const input = toolCall.input as { subagent_type?: string; description?: string }
  const subagentType = input.subagent_type || 'Agent'
  const description = input.description || ''

  // Stats from completed subagent
  const stats = toolCall.subagent

  const StatusIcon = {
    running: Loader2,
    completed: CheckCircle,
    error: XCircle,
    cancelled: StopCircle,
  }[status]

  const statusColor = {
    running: 'text-blue-500',
    completed: 'text-green-500',
    error: 'text-red-500',
    cancelled: 'text-gray-400',
  }[status]

  // Flatten assistant messages into individual renderable items (text blocks + tool calls)
  type FlatItem =
    | { kind: 'text'; key: string; text: string }
    | { kind: 'tool'; key: string; toolCall: ApiToolCall; messageCreatedAt: Date | string }

  const flatItems = useMemo<FlatItem[]>(() => {
    const assistantMessages = subMessages?.filter(
      (m): m is ApiMessage => m.type === 'assistant'
    ) ?? []
    const items: FlatItem[] = []
    for (const msg of assistantMessages) {
      if (msg.content.text) {
        items.push({ kind: 'text', key: `text-${msg.id}`, text: msg.content.text })
      }
      for (const tc of msg.toolCalls ?? []) {
        items.push({ kind: 'tool', key: `tool-${tc.id}`, toolCall: tc, messageCreatedAt: msg.createdAt })
      }
    }
    return items
  }, [subMessages])

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
    <div className="border rounded-md bg-muted/30 text-sm">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors"
      >
        <StatusIcon
          className={cn(
            'h-4 w-4 shrink-0',
            statusColor,
            isRunning && 'animate-spin'
          )}
        />
        <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="font-mono font-medium truncate">
          {subagentType}
        </span>
        {description && (
          <span className="text-muted-foreground truncate text-xs">
            {description}
          </span>
        )}
        <span className="shrink-0 ml-auto">
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </span>
      </button>

      {/* Body - subagent messages */}
      {expanded && (
        <div className="px-3 pb-3">
          <div className="border-l-2 border-blue-300 dark:border-blue-700 pl-3 space-y-3">
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
                className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 font-medium transition-colors py-1"
              >
                Show all ({totalItems} items)
              </button>
            )}

            {visibleItems.map((item) =>
              item.kind === 'text' ? (
                <div key={item.key} className="prose prose-sm max-w-none break-words dark:prose-invert text-xs">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {item.text}
                  </ReactMarkdown>
                </div>
              ) : (
                <ToolCallItem
                  key={item.key}
                  toolCall={item.toolCall}
                  messageCreatedAt={item.messageCreatedAt}
                  agentSlug={agentSlug}
                />
              )
            )}

            {/* Streaming text from subagent (not yet persisted) */}
            {subagentStreamingMessage && !isStreamingMessagePersisted && (
              <div className="prose prose-sm max-w-none break-words dark:prose-invert text-xs">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {subagentStreamingMessage}
                </ReactMarkdown>
              </div>
            )}

            {/* Streaming tool use from subagent (not yet persisted) */}
            {subagentStreamingToolUse && !isStreamingToolUsePersisted && (
              <StreamingToolCallItem
                name={subagentStreamingToolUse.name}
                partialInput={subagentStreamingToolUse.partialInput}
              />
            )}
          </div>

          {/* Stats footer */}
          {stats && status !== 'running' && (
            <div className="mt-2 text-xs text-muted-foreground italic">
              {stats.totalDurationMs != null && formatDuration(stats.totalDurationMs)}
              {stats.totalTokens != null && (
                <>{stats.totalDurationMs != null && ' · '}{formatTokens(stats.totalTokens)} tokens</>
              )}
              {stats.totalToolUseCount != null && (
                <> · {stats.totalToolUseCount} tool call{stats.totalToolUseCount !== 1 ? 's' : ''}</>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
