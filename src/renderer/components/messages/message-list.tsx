
import { useMessages, useDeleteMessage, useDeleteToolCall } from '@renderer/hooks/use-messages'
import {
  useMessageStream,
  removeSecretRequest,
  removeConnectedAccountRequest,
  removeRemoteMcpRequest,
  removeQuestionRequest,
  removeFileRequest,
  removeBrowserInputRequest,
  removeScriptRunRequest,
  clearCompacting,
} from '@renderer/hooks/use-message-stream'
import { MessageItem } from './message-item'
import { StreamingToolCallItem } from './tool-call-item'
import { CompactBoundaryItem } from './compact-boundary-item'
import { SecretRequestItem } from './secret-request-item'
import { ConnectedAccountRequestItem } from './connected-account-request-item'
import { RemoteMcpRequestItem } from './remote-mcp-request-item'
import { QuestionRequestItem } from './question-request-item'
import { FileRequestItem } from './file-request-item'
import { BrowserInputRequestItem } from './browser-input-request-item'
import { ScriptRunRequestItem } from './script-run-request-item'
import { Loader2, Wrench, WifiOff } from 'lucide-react'
import { FileDownloadPill } from '@renderer/components/ui/file-download-pill'
import { useIsOnline } from '@renderer/context/connectivity-context'
import { useUser } from '@renderer/context/user-context'
import { useEffect, useRef, useCallback, useMemo, Fragment } from 'react'
import { formatElapsed } from '@renderer/hooks/use-elapsed-timer'
import type { ApiMessage, ApiCompactBoundary } from '@shared/lib/types/api'

// Prefix for system-injected user messages that should be hidden in the UI.
// Keep in sync with SYSTEM_MESSAGE_PREFIX in agent-container/src/claude-code.ts
const SYSTEM_MESSAGE_PREFIX = '[SYSTEM] '

interface PendingMessage {
  text: string
  sentAt: number
}

function DeliveredFiles({ files, agentSlug }: { files: { filePath: string }[]; agentSlug: string }) {
  return (
    <div className="flex flex-wrap gap-1.5 ml-11 -mt-1 pb-1">
      {files.map((file, idx) => (
        <FileDownloadPill key={idx} filePath={file.filePath} agentSlug={agentSlug} />
      ))}
    </div>
  )
}

interface MessageListProps {
  sessionId: string
  agentSlug: string
  pendingUserMessage?: PendingMessage | null
  onPendingMessageAppeared?: () => void
}

export function MessageList({ sessionId, agentSlug, pendingUserMessage, onPendingMessageAppeared }: MessageListProps) {
  const { data: messages, isLoading } = useMessages(sessionId, agentSlug)
  const deleteMessage = useDeleteMessage()
  const deleteToolCall = useDeleteToolCall()
  const { canUseAgent } = useUser()
  const isViewOnly = !canUseAgent(agentSlug)

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

  // Check if pending message has appeared in real messages.
  // Once the server persists the user message and it shows up in the fetched
  // messages array, we clear the optimistic pending copy to avoid duplication.
  // We match by both text AND timestamp to handle duplicate message text correctly:
  // only messages created around the time the pending was set can match.
  useEffect(() => {
    if (pendingUserMessage && messages) {
      const found = messages.some(
        (m) => m.type === 'user' &&
          m.content.text === pendingUserMessage.text &&
          new Date(m.createdAt).getTime() >= pendingUserMessage.sentAt - 5000
      )
      if (found) {
        onPendingMessageAppeared?.()
      }
    }
  }, [messages, pendingUserMessage, onPendingMessageAppeared])
  const {
    isActive,
    streamingMessage,
    isStreaming,
    streamingToolUse,
    isCompacting,
    activeSubagents,
    completedSubagents,
    pendingSecretRequests: sseSecretRequests,
    pendingConnectedAccountRequests: sseConnectedAccountRequests,
    pendingRemoteMcpRequests: sseRemoteMcpRequests,
    pendingQuestionRequests: sseQuestionRequests,
    pendingFileRequests: sseFileRequests,
    pendingBrowserInputRequests: sseBrowserInputRequests,
    pendingScriptRunRequests: sseScriptRunRequests,
  } = useMessageStream(sessionId, agentSlug)
  const isOnline = useIsOnline()

  // Derive pending requests from message history (for page refresh recovery)
  // Tool calls without a result are still pending, but only if there are no
  // subsequent user messages (which would indicate user has moved past the request)
  const messagesBasedPendingRequests = useMemo(() => {
    const secretRequests: { toolUseId: string; secretName: string; reason?: string }[] = []
    const connectedAccountRequests: { toolUseId: string; toolkit: string; reason?: string }[] = []
    const questionRequests: {
      toolUseId: string
      questions: Array<{
        question: string
        header: string
        options: Array<{ label: string; description: string }>
        multiSelect: boolean
      }>
    }[] = []
    const fileRequests: { toolUseId: string; description: string; fileTypes?: string }[] = []
    const remoteMcpRequests: { toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' }[] = []
    const browserInputRequests: { toolUseId: string; message: string; requirements: string[] }[] = []
    const scriptRunRequests: { toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell' }[] = []

    if (!messages) return { secretRequests, connectedAccountRequests, questionRequests, fileRequests, remoteMcpRequests, browserInputRequests, scriptRunRequests }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message.type !== 'assistant') continue

      // Skip if there are any user messages after this assistant message
      // This means the user has moved past this request (e.g., interrupted and sent new message)
      // Also consider the optimistic pending user message (not yet persisted)
      const hasSubsequentUserMessage = !!pendingUserMessage || messages.slice(i + 1).some((m) => m.type === 'user')
      if (hasSubsequentUserMessage) continue

      for (const toolCall of message.toolCalls) {
        // Skip if already has a result
        if (toolCall.result !== undefined) continue

        if (toolCall.name === 'mcp__user-input__request_secret') {
          const input = toolCall.input as { secretName?: string; reason?: string }
          if (input.secretName) {
            secretRequests.push({
              toolUseId: toolCall.id,
              secretName: input.secretName,
              reason: input.reason,
            })
          }
        } else if (toolCall.name === 'mcp__user-input__request_connected_account') {
          const input = toolCall.input as { toolkit?: string; reason?: string }
          if (input.toolkit) {
            connectedAccountRequests.push({
              toolUseId: toolCall.id,
              toolkit: input.toolkit,
              reason: input.reason,
            })
          }
        } else if (toolCall.name === 'AskUserQuestion') {
          const input = toolCall.input as {
            questions?: Array<{
              question: string
              header: string
              options: Array<{ label: string; description: string }>
              multiSelect: boolean
            }>
          }
          if (input.questions?.length) {
            questionRequests.push({
              toolUseId: toolCall.id,
              questions: input.questions,
            })
          }
        } else if (toolCall.name === 'mcp__user-input__request_remote_mcp') {
          const input = toolCall.input as { url?: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' }
          if (input.url) {
            remoteMcpRequests.push({
              toolUseId: toolCall.id,
              url: input.url,
              name: input.name,
              reason: input.reason,
              authHint: input.authHint,
            })
          }
        } else if (toolCall.name === 'mcp__user-input__request_file') {
          const input = toolCall.input as { description?: string; fileTypes?: string }
          if (input.description) {
            fileRequests.push({
              toolUseId: toolCall.id,
              description: input.description,
              fileTypes: input.fileTypes,
            })
          }
        } else if (toolCall.name === 'mcp__user-input__request_browser_input') {
          const input = toolCall.input as { message?: string; requirements?: string[] }
          if (input.message) {
            browserInputRequests.push({
              toolUseId: toolCall.id,
              message: input.message,
              requirements: input.requirements || [],
            })
          }
        } else if (toolCall.name === 'mcp__user-input__request_script_run') {
          const input = toolCall.input as { script?: string; explanation?: string; scriptType?: 'applescript' | 'shell' | 'powershell' }
          if (input.script && input.scriptType) {
            scriptRunRequests.push({
              toolUseId: toolCall.id,
              script: input.script,
              explanation: input.explanation || '',
              scriptType: input.scriptType,
            })
          }
        }
      }
    }

    return { secretRequests, connectedAccountRequests, questionRequests, fileRequests, remoteMcpRequests, browserInputRequests, scriptRunRequests }
  }, [messages, pendingUserMessage])

  // Track toolUseIds the user has already answered, so that the message-based
  // recovery source doesn't re-surface them before the tool result is persisted.
  // Cleared when the session goes idle (all tool calls will have results by then).
  const dismissedRequestIds = useRef(new Set<string>())

  // Clear dismissed set when session becomes idle
  const prevIsActive = useRef(isActive)
  if (prevIsActive.current && !isActive) {
    dismissedRequestIds.current.clear()
  }
  prevIsActive.current = isActive

  // Merge SSE-based and message-based pending requests (dedupe by toolUseId)
  // Only include message-based requests when session is active (for page refresh recovery)
  // When session is idle, message-based requests represent interrupted/completed work
  // Filter out dismissed requests so they don't re-surface from the message-based source
  // before the tool result is persisted (race condition with parallel tool calls).
  const pendingSecretRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; secretName: string; reason?: string }[] = []

    const messageBased = isActive ? messagesBasedPendingRequests.secretRequests : []
    for (const req of [...sseSecretRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseSecretRequests, messagesBasedPendingRequests.secretRequests, isActive])

  const pendingConnectedAccountRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; toolkit: string; reason?: string }[] = []

    const messageBased = isActive ? messagesBasedPendingRequests.connectedAccountRequests : []
    for (const req of [...sseConnectedAccountRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseConnectedAccountRequests, messagesBasedPendingRequests.connectedAccountRequests, isActive])

  const pendingQuestionRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: {
      toolUseId: string
      questions: Array<{
        question: string
        header: string
        options: Array<{ label: string; description: string }>
        multiSelect: boolean
      }>
    }[] = []

    const messageBased = isActive ? messagesBasedPendingRequests.questionRequests : []
    for (const req of [...sseQuestionRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseQuestionRequests, messagesBasedPendingRequests.questionRequests, isActive])

  const pendingFileRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; description: string; fileTypes?: string }[] = []

    const messageBased = isActive ? messagesBasedPendingRequests.fileRequests : []
    for (const req of [...sseFileRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseFileRequests, messagesBasedPendingRequests.fileRequests, isActive])

  const pendingRemoteMcpRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; url: string; name?: string; reason?: string; authHint?: 'oauth' | 'bearer' }[] = []

    const messageBased = isActive ? messagesBasedPendingRequests.remoteMcpRequests : []
    for (const req of [...sseRemoteMcpRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseRemoteMcpRequests, messagesBasedPendingRequests.remoteMcpRequests, isActive])

  const pendingBrowserInputRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; message: string; requirements: string[] }[] = []

    const messageBased = isActive ? messagesBasedPendingRequests.browserInputRequests : []
    for (const req of [...sseBrowserInputRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseBrowserInputRequests, messagesBasedPendingRequests.browserInputRequests, isActive])

  const pendingScriptRunRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; script: string; explanation: string; scriptType: 'applescript' | 'shell' | 'powershell' }[] = []

    const messageBased = isActive ? messagesBasedPendingRequests.scriptRunRequests : []
    for (const req of [...sseScriptRunRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId) && !dismissedRequestIds.current.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseScriptRunRequests, messagesBasedPendingRequests.scriptRunRequests, isActive])

  const scrollRef = useRef<HTMLDivElement>(null)
  const isScrolledToBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // Consider "at bottom" if within 80px of the bottom edge
    const threshold = 80
    isScrolledToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold
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

  // Handler to remove a completed secret request
  const handleSecretRequestComplete = useCallback(
    (toolUseId: string) => {
      dismissedRequestIds.current.add(toolUseId)
      removeSecretRequest(sessionId, toolUseId)
    },
    [sessionId]
  )

  // Handler to remove a completed connected account request
  const handleConnectedAccountRequestComplete = useCallback(
    (toolUseId: string) => {
      dismissedRequestIds.current.add(toolUseId)
      removeConnectedAccountRequest(sessionId, toolUseId)
    },
    [sessionId]
  )

  // Handler to remove a completed question request
  const handleQuestionRequestComplete = useCallback(
    (toolUseId: string) => {
      dismissedRequestIds.current.add(toolUseId)
      removeQuestionRequest(sessionId, toolUseId)
    },
    [sessionId]
  )

  // Handler to remove a completed remote MCP request
  const handleRemoteMcpRequestComplete = useCallback(
    (toolUseId: string) => {
      dismissedRequestIds.current.add(toolUseId)
      removeRemoteMcpRequest(sessionId, toolUseId)
    },
    [sessionId]
  )

  // Handler to remove a completed file request
  const handleFileRequestComplete = useCallback(
    (toolUseId: string) => {
      dismissedRequestIds.current.add(toolUseId)
      removeFileRequest(sessionId, toolUseId)
    },
    [sessionId]
  )

  // Handler to remove a completed script run request
  const handleScriptRunRequestComplete = useCallback(
    (toolUseId: string) => {
      dismissedRequestIds.current.add(toolUseId)
      removeScriptRunRequest(sessionId, toolUseId)
    },
    [sessionId]
  )

  // Handler to remove a completed browser input request
  const handleBrowserInputRequestComplete = useCallback(
    (toolUseId: string) => {
      dismissedRequestIds.current.add(toolUseId)
      removeBrowserInputRequest(sessionId, toolUseId)
    },
    [sessionId]
  )

  // Check if streaming message is already in persisted messages (prevents double-render)
  const isStreamingMessagePersisted = useMemo(() => {
    if (!streamingMessage || !messages?.length) return false

    // Find the last assistant message
    const lastAssistantMessage = [...messages].reverse().find((m): m is ApiMessage => m.type === 'assistant')
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

  // Check if streaming tool use is already in persisted messages (prevents double-render)
  const isStreamingToolUsePersisted = useMemo(() => {
    if (!streamingToolUse || !messages?.length) return false
    return messages.some(m =>
      m.type === 'assistant' &&
      m.toolCalls.some(tc => tc.id === streamingToolUse.id)
    )
  }, [messages, streamingToolUse])

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
      (streamingToolUse && !isStreamingToolUsePersisted)
    if (!hasUnpersistedStreaming) return null
    // Find the last persisted assistant message — that's where the elapsed time would wrongly appear.
    // But if we hit a user message first, the streaming belongs to a NEW turn and we
    // shouldn't defer the previous turn's elapsed/files.
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'assistant') return messages[i].id
      if (messages[i].type === 'user') return null
    }
    return null
  }, [messages, pendingUserMessage, streamingMessage, isStreamingMessagePersisted, streamingToolUse, isStreamingToolUsePersisted])

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
    }
  }, [pendingUserMessage])

  // Auto-scroll to bottom when new messages arrive or requests appear,
  // but only if the user hasn't scrolled up to read earlier content.
  useEffect(() => {
    if (scrollRef.current && isScrolledToBottomRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, pendingUserMessage, streamingMessage, streamingToolUse, isCompacting, pendingSecretRequests, pendingConnectedAccountRequests, pendingQuestionRequests, pendingFileRequests, pendingRemoteMcpRequests, pendingBrowserInputRequests, pendingScriptRunRequests, activeSubagents])

  if (isLoading && !pendingUserMessage) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="overflow-y-auto" ref={scrollRef} onScroll={handleScroll} data-testid="message-list">
      <div className="p-4 space-y-4">
        {messages?.filter((item) => {
          // Hide system-injected user messages (e.g., MCP registration continuation)
          if (item.type === 'user') {
            const msg = item as ApiMessage
            if (msg.content?.text?.startsWith(SYSTEM_MESSAGE_PREFIX)) return false
          }
          return true
        }).map((item) => (
          <Fragment key={item.id}>
            {item.type === 'compact_boundary' ? (
              <CompactBoundaryItem boundary={item as ApiCompactBoundary} />
            ) : (
              <>
                <MessageItem message={item as ApiMessage} agentSlug={agentSlug} sessionId={sessionId} isSessionActive={canHaveRunningToolCalls.has(item.id)} activeSubagents={activeSubagents} completedSubagents={completedSubagents} onRemoveMessage={handleRemoveMessage} onRemoveToolCall={handleRemoveToolCall} />
                {turnDeliveredFiles.has(item.id) && item.id !== deferredElapsedMessageId && (
                  <DeliveredFiles files={turnDeliveredFiles.get(item.id)!} agentSlug={agentSlug} />
                )}
                {turnElapsedTimes.has(item.id) && item.id !== deferredElapsedMessageId && (
                  <div className="text-xs text-muted-foreground pb-1 -mt-1 tabular-nums ml-11 italic">
                    Agent took {formatElapsed(turnElapsedTimes.get(item.id)!)}
                  </div>
                )}
              </>
            )}
          </Fragment>
        ))}

        {/* Pending user message - shown immediately after sending */}
        {pendingUserMessage && (
          <MessageItem
            message={{
              id: 'pending-user-message',
              type: 'user',
              content: { text: pendingUserMessage.text },
              toolCalls: [],
              createdAt: new Date(),
            }}
            agentSlug={agentSlug}
          />
        )}

        {/* Streaming text message - keep visible until persisted data arrives */}
        {streamingMessage && !isStreamingMessagePersisted && (
          <MessageItem
            message={{
              id: 'streaming',
              type: 'assistant',
              content: { text: streamingMessage },
              toolCalls: [],
              createdAt: new Date(),
            }}
            isStreaming={isStreaming}
          />
        )}

        {/* Tool use streaming - keep visible until persisted data arrives */}
        {streamingToolUse && !isStreamingToolUsePersisted && (
          <div className="flex gap-3">
            <div className="h-8 w-8 rounded-full flex items-center justify-center shrink-0 bg-muted">
              <Wrench className="h-4 w-4" />
            </div>
            <div className="flex-1 max-w-[80%]">
              <StreamingToolCallItem
                name={streamingToolUse.name}
                partialInput={streamingToolUse.partialInput}
              />
            </div>
          </div>
        )}

        {/* Deferred delivered files + elapsed time — shown after streaming content */}
        {deferredElapsedMessageId && turnDeliveredFiles.has(deferredElapsedMessageId) && (
          <DeliveredFiles files={turnDeliveredFiles.get(deferredElapsedMessageId)!} agentSlug={agentSlug} />
        )}
        {deferredElapsedMessageId && turnElapsedTimes.has(deferredElapsedMessageId) && (
          <div className="text-xs text-muted-foreground pb-1 -mt-1 tabular-nums ml-11 italic">
            Agent took {formatElapsed(turnElapsedTimes.get(deferredElapsedMessageId)!)}
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

        {/* Pending interactive requests — read-only for viewers */}
        {pendingSecretRequests.map((request) => (
          <SecretRequestItem
            key={request.toolUseId}
            toolUseId={request.toolUseId}
            secretName={request.secretName}
            reason={request.reason}
            sessionId={sessionId}
            agentSlug={agentSlug}
            readOnly={isViewOnly}
            onComplete={() => handleSecretRequestComplete(request.toolUseId)}
          />
        ))}
        {pendingConnectedAccountRequests.map((request) => (
          <ConnectedAccountRequestItem
            key={request.toolUseId}
            toolUseId={request.toolUseId}
            toolkit={request.toolkit}
            reason={request.reason}
            sessionId={sessionId}
            agentSlug={agentSlug}
            readOnly={isViewOnly}
            onComplete={() => handleConnectedAccountRequestComplete(request.toolUseId)}
          />
        ))}
        {pendingRemoteMcpRequests.map((request) => (
          <RemoteMcpRequestItem
            key={request.toolUseId}
            toolUseId={request.toolUseId}
            url={request.url}
            name={request.name}
            reason={request.reason}
            authHint={request.authHint}
            sessionId={sessionId}
            agentSlug={agentSlug}
            readOnly={isViewOnly}
            onComplete={() => handleRemoteMcpRequestComplete(request.toolUseId)}
          />
        ))}
        {pendingQuestionRequests.map((request) => (
          <QuestionRequestItem
            key={request.toolUseId}
            toolUseId={request.toolUseId}
            questions={request.questions}
            sessionId={sessionId}
            agentSlug={agentSlug}
            readOnly={isViewOnly}
            onComplete={() => handleQuestionRequestComplete(request.toolUseId)}
          />
        ))}
        {pendingFileRequests.map((request) => (
          <FileRequestItem
            key={request.toolUseId}
            toolUseId={request.toolUseId}
            description={request.description}
            fileTypes={request.fileTypes}
            sessionId={sessionId}
            agentSlug={agentSlug}
            readOnly={isViewOnly}
            onComplete={() => handleFileRequestComplete(request.toolUseId)}
          />
        ))}
        {pendingBrowserInputRequests.map((request) => (
          <BrowserInputRequestItem
            key={request.toolUseId}
            toolUseId={request.toolUseId}
            message={request.message}
            requirements={request.requirements}
            sessionId={sessionId}
            agentSlug={agentSlug}
            readOnly={isViewOnly}
            onComplete={() => handleBrowserInputRequestComplete(request.toolUseId)}
          />
        ))}
        {pendingScriptRunRequests.map((request) => (
          <ScriptRunRequestItem
            key={request.toolUseId}
            toolUseId={request.toolUseId}
            script={request.script}
            explanation={request.explanation}
            scriptType={request.scriptType}
            sessionId={sessionId}
            agentSlug={agentSlug}
            readOnly={isViewOnly}
            onComplete={() => handleScriptRunRequestComplete(request.toolUseId)}
          />
        ))}
      </div>
    </div>
  )
}
