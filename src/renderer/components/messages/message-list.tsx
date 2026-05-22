
import { useMessages, useDeleteMessage, useDeleteToolCall, TranscriptNotFoundError } from '@renderer/hooks/use-messages'
import { useAgent } from '@renderer/hooks/use-agents'
import { useIsVoiceAgentConfigured } from '@renderer/hooks/use-voice-input'
import { VoiceAgentFeedbackDialog } from './voice-agent-feedback-dialog'
import {
  useMessageStream,
  clearCompacting,
} from '@renderer/hooks/use-message-stream'
import { MessageItem } from './message-item'
import { ToolCallItem, StreamingToolCallItem } from './tool-call-item'
import { SubAgentBlock } from './subagent-block'
import { CompactBoundaryItem } from './compact-boundary-item'
import { MemoryRecallItem } from './memory-recall-item'
import { MessageErrorBoundary } from './message-error-boundary'
import { AgentActivityIndicator } from './agent-activity-indicator'
import { ArrowDown, FileX2, Loader2, MessageSquarePlus, WifiOff } from 'lucide-react'
import { FileDownloadPill } from '@renderer/components/ui/file-download-pill'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { useUser } from '@renderer/context/user-context'
import { useDraft } from '@renderer/context/drafts-context'
import { useRenderTracker } from '@renderer/lib/perf'
import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, Fragment, type ReactNode } from 'react'
import { formatElapsed } from '@renderer/hooks/use-elapsed-timer'
import type { ApiMessage, ApiCompactBoundary, ApiMemoryRecall } from '@shared/lib/types/api'

// Prefix for system-injected user messages that should be hidden in the UI.
// Keep in sync with SYSTEM_MESSAGE_PREFIX in agent-container/src/claude-code.ts
const SYSTEM_MESSAGE_PREFIX = '[SYSTEM] '

// On very long threads we render only a trailing window of messages to keep the
// DOM small. Sessions with <= BASE_WINDOW visible items render in full, so small
// and medium threads are completely unaffected. Scrolling near the top reveals
// LOAD_STEP more at a time. The window is a fixed-size tail slice, so while new
// messages stream in at the bottom the oldest rendered ones drop off the top and
// the DOM node count stays flat. The window only grows on an explicit scroll-up
// and is reset when the session changes.
const BASE_WINDOW = 300
const LOAD_STEP = 200

interface PendingMessage {
  text: string
  sentAt: number
  sender?: { id: string; name: string; email: string }
}

function DeliveredFiles({ files, agentSlug }: { files: { filePath: string }[]; agentSlug: string }) {
  return (
    <div className="flex flex-wrap gap-1.5 ml-11 -mt-1 pb-1">
      {files.map((file) => (
        <FileDownloadPill key={file.filePath} filePath={file.filePath} agentSlug={agentSlug} />
      ))}
    </div>
  )
}

interface MessageListProps {
  sessionId: string
  agentSlug: string
  pendingUserMessage?: PendingMessage | null
  pendingRequestCount?: number
  onPendingMessageAppeared?: () => void
}

export function MessageList({ sessionId, agentSlug, pendingUserMessage, pendingRequestCount = 0, onPendingMessageAppeared }: MessageListProps) {
  useRenderTracker('MessageList')
  const { data: messages, isLoading, error } = useMessages(sessionId, agentSlug)
  const deleteMessage = useDeleteMessage()
  const deleteToolCall = useDeleteToolCall()
  const { user } = useUser()
  const [, setSessionDraft] = useDraft<string>(`session:${sessionId}`)

  const handleRemoveMessage = useCallback(
    (messageId: string) => {
      deleteMessage.mutate({ sessionId, agentSlug, messageId })
    },
    [sessionId, agentSlug, deleteMessage]
  )

  const handleRemoveToolCall = useCallback(
    (toolCallId: string) => {
      deleteToolCall.mutate({ sessionId, agentSlug, toolCallId })
    },
    [sessionId, agentSlug, deleteToolCall]
  )

  // Voice Agent feedback dialog state
  const { data: agentData } = useAgent(agentSlug)
  const hasVoiceConfigured = useIsVoiceAgentConfigured()
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false)

  const handleProvideFeedback = useCallback(() => {
    setFeedbackDialogOpen(true)
  }, [])

  // Find the last assistant message that has an elapsed time (for voice feedback button)
  const lastAssistantElapsedId = useMemo(() => {
    if (!messages) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.type === 'assistant') return m.id
    }
    return null
  }, [messages])

  // Collect plain-text messages for the feedback dialog context
  const plainMessages = useMemo(() => {
    if (!messages) return []
    return messages.filter(
      (m): m is ApiMessage => (m.type === 'user' || m.type === 'assistant')
    )
  }, [messages])

  // Check if pending message has appeared in real messages.
  // Once the server persists the user message and it shows up in the fetched
  // messages array, we clear the optimistic pending copy to avoid duplication.
  // We match by both text AND timestamp to handle duplicate message text correctly:
  // only messages created around the time the pending was set can match.
  // Text comparison uses trimmed values to handle trailing whitespace/newlines
  // that the SDK may add when persisting to JSONL.
  useEffect(() => {
    if (pendingUserMessage && messages) {
      const pendingText = pendingUserMessage.text.trim()
      const found = messages.some(
        (m) => m.type === 'user' &&
          (m.content as { text?: string }).text?.trim() === pendingText &&
          new Date(m.createdAt).getTime() >= pendingUserMessage.sentAt - 5000
      )
      if (found) {
        onPendingMessageAppeared?.()
      }
    }
  }, [messages, pendingUserMessage, onPendingMessageAppeared])

  // Safety net: clear pending message after 10 seconds even if text matching
  // fails (e.g., due to filesystem sync delays or unexpected text transforms).
  // By this time the message has certainly been persisted.
  useEffect(() => {
    if (!pendingUserMessage) return
    const timerId = setTimeout(() => {
      onPendingMessageAppeared?.()
    }, 10000)
    return () => clearTimeout(timerId)
  }, [pendingUserMessage, onPendingMessageAppeared])
  const {
    isActive,
    streamingMessage,
    isStreaming,
    streamingToolUses,
    isCompacting,
    activeSubagents,
    completedSubagents,
    apiErrorCode,
    typingUser,
    peerUserMessage,
  } = useMessageStream(sessionId, agentSlug)
  const isOnline = useIsOnline()

  const scrollRef = useRef<HTMLDivElement>(null)
  const isScrolledToBottomRef = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  // How many trailing (visible) messages to render. Grows on scroll-up and while
  // the user is scrolled up during streaming. Starts at BASE_WINDOW; the component
  // is keyed by sessionId at its mount site, so a switched session remounts fresh.
  const [windowSize, setWindowSize] = useState(BASE_WINDOW)
  // Scroll height captured just before a scroll-up expansion, used to re-anchor the
  // viewport after the larger slice renders so the content under the user doesn't jump.
  const prevScrollHeightRef = useRef<number | null>(null)

  // Visible messages with system-injected entries filtered out (these must not
  // consume window slots, and the windowing operates on what the user can see).
  const visibleMessages = useMemo(() => {
    if (!messages) return []
    return messages.filter((item) => {
      if (item.type === 'user') {
        const msg = item as ApiMessage
        if (msg.content?.text?.startsWith(SYSTEM_MESSAGE_PREFIX)) return false
      }
      return true
    })
  }, [messages])

  // The trailing slice we actually render. The other derived values below still
  // compute over the FULL message list, so turn boundaries / elapsed times / etc.
  // stay correct even when their anchor message is outside the rendered window.
  const windowedMessages = useMemo(
    () => visibleMessages.slice(-windowSize),
    [visibleMessages, windowSize]
  )
  const hiddenCount = visibleMessages.length - windowedMessages.length

  // Keep the rendered range anchored at the top while the user is scrolled up.
  // The window is a trailing slice, so when new messages are persisted it would
  // normally drop the same number off the top — shifting the content the user is
  // reading (overflow-anchor is disabled, so nothing compensates). Growing the
  // window by exactly that delta keeps the same first rendered item; the new
  // messages just append below, off-screen. When pinned to the bottom we leave the
  // window alone so the slice slides and the DOM stays bounded.
  const prevVisibleLenRef = useRef(visibleMessages.length)
  useLayoutEffect(() => {
    const grown = visibleMessages.length - prevVisibleLenRef.current
    prevVisibleLenRef.current = visibleMessages.length
    if (grown > 0 && !isScrolledToBottomRef.current) {
      setWindowSize((n) => n + grown)
    }
  }, [visibleMessages])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // Consider "at bottom" if within 80px of the bottom edge
    const threshold = 80
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    isScrolledToBottomRef.current = distanceFromBottom < threshold
    // Show "scroll to bottom" button when scrolled up more than 300px
    setShowScrollToBottom(distanceFromBottom > 300)

    // Near the top with older messages still hidden: reveal the next chunk.
    // prevScrollHeightRef doubles as a re-entrancy guard so we expand at most once
    // per scroll gesture; the layout effect clears it after re-anchoring.
    if (el.scrollTop < 200 && prevScrollHeightRef.current == null && hiddenCount > 0) {
      prevScrollHeightRef.current = el.scrollHeight
      // The user is reading older content — make sure nothing auto-pins to the
      // bottom during the expand (the distance heuristic can misfire when the
      // rendered slice barely overflows the viewport).
      isScrolledToBottomRef.current = false
      setWindowSize((n) => n + LOAD_STEP)
    }
  }, [hiddenCount])

  // After a scroll-up expansion adds older messages above the viewport, restore the
  // scroll position so the content the user was reading stays put (no jump).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && prevScrollHeightRef.current != null) {
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current
      prevScrollHeightRef.current = null
    }
  }, [windowSize])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  // Safety net: if isCompacting is true but a NEW compact boundary appears in fetched
  // messages, compaction is done and the SSE compact_complete event was missed.
  // Track the boundary count baseline when not compacting, then detect increases.
  const boundaryCountRef = useRef(0)
  const boundaryCount = useMemo(
    () => messages?.filter(m => m.type === 'compact_boundary').length ?? 0,
    [messages]
  )
  useEffect(() => {
    if (isCompacting && boundaryCount > boundaryCountRef.current) {
      clearCompacting(sessionId)
    }
    if (!isCompacting) {
      boundaryCountRef.current = boundaryCount
    }
  }, [isCompacting, boundaryCount, sessionId])

  // Check if streaming message is already in persisted messages (prevents double-render)
  const isStreamingMessagePersisted = useMemo(() => {
    if (!streamingMessage || !messages?.length) return false

    // Find the last assistant message (backward scan; avoids copying and
    // reversing the whole array on every streaming delta).
    let lastAssistantMessage: ApiMessage | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'assistant') {
        lastAssistantMessage = messages[i] as ApiMessage
        break
      }
    }
    if (!lastAssistantMessage) return false

    // Check if the persisted message text contains the streaming content
    const content = lastAssistantMessage.content as { text?: string } | undefined
    const persistedText = content?.text?.trim() || ''
    const streamingText = streamingMessage.trim()

    // Both texts must be non-empty for comparison
    if (!persistedText || !streamingText) return false

    // If streaming text is a prefix of (or equal to) persisted text, it's already persisted
    // Also check if persisted text starts with streaming text (streaming may be slightly behind)
    return persistedText.startsWith(streamingText) || streamingText.startsWith(persistedText)
  }, [messages, streamingMessage])

  // Filter streaming tool uses to only those NOT yet in persisted messages
  const unpersistedStreamingToolUses = useMemo(() => {
    if (!streamingToolUses.length || !messages?.length) return streamingToolUses
    const persistedToolIds = new Set<string>()
    for (const m of messages) {
      if (m.type === 'assistant') {
        for (const tc of (m as ApiMessage).toolCalls) {
          persistedToolIds.add(tc.id)
        }
      }
    }
    return streamingToolUses.filter(t => !persistedToolIds.has(t.id))
  }, [messages, streamingToolUses])

  // Compute elapsed time for each completed response turn
  // A turn starts with a user message and ends at the last assistant message before the next user message (or end of messages when idle)
  const turnElapsedTimes = useMemo(() => {
    const elapsed = new Map<string, number>()
    if (!messages) return elapsed

    let lastUserMessageTime: number | null = null
    let lastAssistantMessageId: string | null = null
    let lastAssistantMessageTime: number | null = null

    for (const msg of messages) {
      if (msg.type === 'user') {
        // Close previous turn
        if (lastUserMessageTime && lastAssistantMessageId && lastAssistantMessageTime) {
          elapsed.set(lastAssistantMessageId, lastAssistantMessageTime - lastUserMessageTime)
        }
        lastUserMessageTime = new Date(msg.createdAt).getTime()
        lastAssistantMessageId = null
        lastAssistantMessageTime = null
      } else if (msg.type === 'assistant') {
        lastAssistantMessageId = msg.id
        lastAssistantMessageTime = new Date(msg.createdAt).getTime()
      }
    }

    // Close the last turn if session is idle, or if the user has sent a new message
    // (pendingUserMessage means a new turn started, so the previous one is complete)
    if ((!isActive || pendingUserMessage) && lastUserMessageTime && lastAssistantMessageId && lastAssistantMessageTime) {
      elapsed.set(lastAssistantMessageId, lastAssistantMessageTime - lastUserMessageTime)
    }

    return elapsed
  }, [messages, isActive, pendingUserMessage])

  // Collect delivered files for each completed turn (same turn boundaries as turnElapsedTimes)
  const turnDeliveredFiles = useMemo(() => {
    const filesMap = new Map<string, { filePath: string }[]>()
    if (!messages) return filesMap

    let turnFiles: { filePath: string }[] = []
    let lastAssistantMessageId: string | null = null

    for (const msg of messages) {
      if (msg.type === 'user') {
        if (lastAssistantMessageId && turnFiles.length > 0) {
          filesMap.set(lastAssistantMessageId, turnFiles)
        }
        turnFiles = []
        lastAssistantMessageId = null
      } else if (msg.type === 'assistant') {
        lastAssistantMessageId = msg.id
        for (const tc of msg.toolCalls) {
          if (tc.name === 'mcp__user-input__deliver_file' && !tc.isError) {
            const input = tc.input as { filePath?: string }
            if (input.filePath) {
              turnFiles.push({ filePath: input.filePath })
            }
          }
        }
      }
    }

    if ((!isActive || pendingUserMessage) && lastAssistantMessageId && turnFiles.length > 0) {
      filesMap.set(lastAssistantMessageId, turnFiles)
    }

    return filesMap
  }, [messages, isActive, pendingUserMessage])

  // If there's unpersisted streaming content, defer the last turn's elapsed time
  // to render after the streaming section (otherwise it appears above the streaming message).
  // Exception: if pendingUserMessage exists, streaming belongs to the NEW turn, so the
  // previous turn's elapsed/files should render inline (not deferred after new streaming).
  const deferredElapsedMessageId = useMemo(() => {
    if (!messages || pendingUserMessage) return null
    const hasUnpersistedStreaming =
      (streamingMessage && !isStreamingMessagePersisted) ||
      unpersistedStreamingToolUses.length > 0
    if (!hasUnpersistedStreaming) return null
    // Find the last persisted assistant message — that's where the elapsed time would wrongly appear.
    // But if we hit a user message first, the streaming belongs to a NEW turn and we
    // shouldn't defer the previous turn's elapsed/files.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'assistant') return messages[i].id
      if (messages[i].type === 'user') return null
    }
    return null
  }, [messages, pendingUserMessage, streamingMessage, isStreamingMessagePersisted, unpersistedStreamingToolUses])

  // Determine which messages could have tool calls that are still running.
  // Only the trailing assistant messages (after the last user message) can have running tools,
  // and only if the session is active and there's no pending user message (which means user moved on).
  const canHaveRunningToolCalls = useMemo(() => {
    const result = new Set<string>()
    if (!messages || !isActive || pendingUserMessage) return result

    // Walk backwards - only assistant messages after the last user message can have running tools
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user') break
      if (messages[i].type === 'assistant') {
        result.add(messages[i].id)
      }
    }
    return result
  }, [messages, isActive, pendingUserMessage])

  // Re-pin to bottom when the user sends a new message
  useEffect(() => {
    if (pendingUserMessage) {
      isScrolledToBottomRef.current = true
      setShowScrollToBottom(false)
    }
  }, [pendingUserMessage])

  // Auto-scroll to bottom when new messages arrive or requests appear,
  // but only if the user hasn't scrolled up to read earlier content.
  useEffect(() => {
    if (scrollRef.current && isScrolledToBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, pendingUserMessage, streamingMessage, streamingToolUses, isCompacting, pendingRequestCount, activeSubagents])

  if (isLoading && !pendingUserMessage) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // The transcript file is gone (e.g. removed by the CLI's retention cleanup)
  // while the session still appears in the nav. Don't show this during the brief
  // new-session window — the creating client has a pendingUserMessage then.
  if (error instanceof TranscriptNotFoundError && !pendingUserMessage) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center">
        <FileX2 className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">Session transcript not found</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          This session&apos;s transcript is no longer available. You can remove it from the list.
        </p>
      </div>
    )
  }

  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      <div className="overflow-y-auto h-full" style={{ overflowAnchor: 'none' }} ref={scrollRef} onScroll={handleScroll} data-testid="message-list">
        <div className="mx-auto w-full max-w-[720px] px-4 pb-4 pt-14 space-y-4">
        {hiddenCount > 0 && (
          <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
            {hiddenCount} earlier {hiddenCount === 1 ? 'message' : 'messages'} hidden — scroll up to load
          </div>
        )}
        {windowedMessages.map((item) => (
          <Fragment key={item.id}>
            {item.type === 'memory_recall' ? (
              <MemoryRecallItem recall={item as ApiMemoryRecall} />
            ) : item.type === 'compact_boundary' ? (
              <CompactBoundaryItem boundary={item as ApiCompactBoundary} />
            ) : (
              <>
                <MessageErrorBoundary kind="message" raw={item} itemId={item.id}>
                  <MessageItem message={item as ApiMessage} agentSlug={agentSlug} sessionId={sessionId} isSessionActive={canHaveRunningToolCalls.has(item.id)} activeSubagents={activeSubagents} completedSubagents={completedSubagents} onRemoveMessage={handleRemoveMessage} onRemoveToolCall={handleRemoveToolCall} />
                </MessageErrorBoundary>
                {turnDeliveredFiles.has(item.id) && item.id !== deferredElapsedMessageId && (
                  <DeliveredFiles files={turnDeliveredFiles.get(item.id)!} agentSlug={agentSlug} />
                )}
                {turnElapsedTimes.has(item.id) && item.id !== deferredElapsedMessageId && (
                  <div className="flex items-center gap-3 pb-1 -mt-3 text-xs text-muted-foreground tabular-nums italic">
                    <span>Worked for {formatElapsed(turnElapsedTimes.get(item.id)!)}</span>
                    <div className="h-px flex-1 bg-border" />
                    {hasVoiceConfigured && (item as ApiMessage).type === 'assistant' && item.id === lastAssistantElapsedId && (
                      <button
                        type="button"
                        onClick={handleProvideFeedback}
                        className="flex items-center gap-1 not-italic text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <MessageSquarePlus className="h-3 w-3" />
                        <span>Voice feedback</span>
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </Fragment>
        ))}

        {/* Peer user message — optimistic display until persisted data arrives.
            Hidden if sender is the current user (they see their own pendingUserMessage)
            or if the message already appeared in the fetched messages list. */}
        {peerUserMessage &&
          peerUserMessage.sender.id !== user?.id &&
          !messages?.some((m) => m.type === 'user' && (m.content as { text?: string }).text?.trim() === peerUserMessage.content.trim()) && (
          <MessageErrorBoundary kind="message" raw={peerUserMessage} itemId="peer-user-message">
            <MessageItem
              message={{
                id: 'peer-user-message',
                type: 'user',
                content: { text: peerUserMessage.content },
                toolCalls: [],
                createdAt: new Date(),
                ...(peerUserMessage.sender.name ? { sender: { id: peerUserMessage.sender.id, name: peerUserMessage.sender.name, email: peerUserMessage.sender.email || '' } } : {}),
              }}
              agentSlug={agentSlug}
            />
          </MessageErrorBoundary>
        )}

        {/* Pending user message - shown immediately after sending */}
        {pendingUserMessage && (
          <MessageErrorBoundary kind="message" raw={pendingUserMessage} itemId="pending-user-message">
            <MessageItem
              message={{
                id: 'pending-user-message',
                type: 'user',
                content: { text: pendingUserMessage.text },
                toolCalls: [],
                createdAt: new Date(),
                sender: pendingUserMessage.sender,
              }}
              agentSlug={agentSlug}
            />
          </MessageErrorBoundary>
        )}

        {/* Typing indicator - shown when another user is typing */}
        {typingUser && !peerUserMessage && (
          <div className="flex gap-3 flex-row-reverse">
            <div className="h-8 w-8 rounded-full items-center justify-center shrink-0 hidden md:flex bg-primary text-primary-foreground">
              <span className="text-xs font-medium">
                {typingUser.name?.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?'}
              </span>
            </div>
            <div className="rounded-lg px-4 py-2 bg-primary text-primary-foreground">
              <span className="animate-pulse tracking-widest">...</span>
            </div>
          </div>
        )}

        {/* Streaming text message - keep visible until persisted data arrives */}
        {streamingMessage && !isStreamingMessagePersisted && (
          <MessageErrorBoundary kind="message" raw={streamingMessage} itemId="streaming">
            <MessageItem
              message={{
                id: 'streaming',
                type: 'assistant',
                content: { text: streamingMessage },
                toolCalls: [],
                createdAt: new Date(),
                ...(apiErrorCode && { apiError: apiErrorCode }),
              }}
              isStreaming={isStreaming}
            />
          </MessageErrorBoundary>
        )}

        {/* Tool use streaming - keep visible until persisted data arrives */}
        {unpersistedStreamingToolUses.map(tool => {
          let inner: ReactNode
          if (tool.ready) {
            let input: Record<string, unknown> = {}
            try { input = JSON.parse(tool.partialInput) } catch { /* use empty */ }
            const syntheticToolCall = { id: tool.id, name: tool.name, input }
            if ((tool.name === 'Task' || tool.name === 'Agent') && sessionId) {
              inner = (
                <SubAgentBlock
                  toolCall={syntheticToolCall}
                  sessionId={sessionId}
                  agentSlug={agentSlug}
                  isSessionActive={isActive}
                  activeSubagent={activeSubagents?.find(s => s.parentToolId === tool.id) ?? null}
                  isCompleted={completedSubagents?.has(tool.id) ?? false}
                />
              )
            } else {
              inner = (
                <div className="max-w-[80%]">
                  <ToolCallItem toolCall={syntheticToolCall} agentSlug={agentSlug} isSessionActive={isActive} />
                </div>
              )
            }
          } else {
            inner = (
              <div className="max-w-[80%]">
                <StreamingToolCallItem
                  name={tool.name}
                  partialInput={tool.partialInput}
                />
              </div>
            )
          }
          return (
            <MessageErrorBoundary key={tool.id} kind="tool call" raw={tool} itemId={tool.id}>
              {inner}
            </MessageErrorBoundary>
          )
        })}

        {/* Deferred delivered files + elapsed time — shown after streaming content */}
        {deferredElapsedMessageId && turnDeliveredFiles.has(deferredElapsedMessageId) && (
          <DeliveredFiles files={turnDeliveredFiles.get(deferredElapsedMessageId)!} agentSlug={agentSlug} />
        )}
        {deferredElapsedMessageId && turnElapsedTimes.has(deferredElapsedMessageId) && (
          <div className="flex items-center gap-3 pb-1 -mt-3 text-xs text-muted-foreground tabular-nums italic">
            <span>Worked for {formatElapsed(turnElapsedTimes.get(deferredElapsedMessageId)!)}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
        )}

        {/* Connection lost warning during active session */}
        {isActive && !isOnline && (
          <div className="flex gap-3">
            <div className="h-8 w-8 rounded-full flex items-center justify-center shrink-0 bg-amber-100 dark:bg-amber-900/30">
              <WifiOff className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="flex-1 rounded-lg px-4 py-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-200">
              Internet connection lost.
              <br />
              <span className="text-xs text-amber-600 dark:text-amber-500">
                The agent may still be running. Messages will appear once connection is restored.
              </span>
            </div>
          </div>
        )}

        {/* Real-time compacting indicator */}
        {isCompacting && (
          <CompactBoundaryItem isCompacting />
        )}

        {/* Pending interactive requests render in the composer slot — see SessionChatColumn. */}

        {/* Working / awaiting / error indicator, appended to the thread tail. */}
        <AgentActivityIndicator sessionId={sessionId} agentSlug={agentSlug} />
        </div>
      </div>
      {showScrollToBottom && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium shadow-lg hover:bg-primary/90 transition-opacity cursor-pointer"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Scroll to bottom
        </button>
      )}

      {/* Voice Agent feedback dialog */}
      <VoiceAgentFeedbackDialog
        open={feedbackDialogOpen}
        onOpenChange={setFeedbackDialogOpen}
        agentInstructions={agentData?.instructions ?? ''}
        messages={plainMessages}
        onSetDraft={setSessionDraft}
      />
    </div>
  )
}

if (__RENDER_TRACKING__) {
  (MessageList as any).whyDidYouRender = true
}
