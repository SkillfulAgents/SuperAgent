
import { useMessages } from '@renderer/hooks/use-messages'
import {
  useMessageStream,
  removeSecretRequest,
  removeConnectedAccountRequest,
  removeQuestionRequest,
  removeFileRequest,
} from '@renderer/hooks/use-message-stream'
import { MessageItem } from './message-item'
import { StreamingToolCallItem } from './tool-call-item'
import { SecretRequestItem } from './secret-request-item'
import { ConnectedAccountRequestItem } from './connected-account-request-item'
import { QuestionRequestItem } from './question-request-item'
import { FileRequestItem } from './file-request-item'
import { Loader2, Wrench } from 'lucide-react'
import { useEffect, useRef, useCallback, useMemo } from 'react'

interface MessageListProps {
  sessionId: string
  agentSlug: string
  pendingUserMessage?: string | null
  onPendingMessageAppeared?: () => void
}

export function MessageList({ sessionId, agentSlug, pendingUserMessage, onPendingMessageAppeared }: MessageListProps) {
  const { data: messages, isLoading } = useMessages(sessionId, agentSlug)

  // Check if pending message has appeared in real messages
  // We track the message count when the pending message was set to avoid
  // false positives from older messages with the same text
  const messageCountWhenPendingSet = useRef<number | null>(null)
  useEffect(() => {
    if (pendingUserMessage && messages) {
      if (messageCountWhenPendingSet.current === null) {
        // First time seeing this pending message - record current count
        messageCountWhenPendingSet.current = messages.length
      } else {
        // Check if any NEW messages (after the pending was set) match
        const newMessages = messages.slice(messageCountWhenPendingSet.current)
        const found = newMessages.some(
          (m) => m.type === 'user' && m.content.text === pendingUserMessage
        )
        if (found) {
          messageCountWhenPendingSet.current = null
          onPendingMessageAppeared?.()
        }
      }
    } else {
      // Reset when pending message is cleared
      messageCountWhenPendingSet.current = null
    }
  }, [messages, pendingUserMessage, onPendingMessageAppeared])
  const {
    isActive,
    streamingMessage,
    isStreaming,
    streamingToolUse,
    pendingSecretRequests: sseSecretRequests,
    pendingConnectedAccountRequests: sseConnectedAccountRequests,
    pendingQuestionRequests: sseQuestionRequests,
    pendingFileRequests: sseFileRequests,
  } = useMessageStream(sessionId, agentSlug)

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

    if (!messages) return { secretRequests, connectedAccountRequests, questionRequests, fileRequests }

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
        } else if (toolCall.name === 'mcp__user-input__request_file') {
          const input = toolCall.input as { description?: string; fileTypes?: string }
          if (input.description) {
            fileRequests.push({
              toolUseId: toolCall.id,
              description: input.description,
              fileTypes: input.fileTypes,
            })
          }
        }
      }
    }

    return { secretRequests, connectedAccountRequests, questionRequests, fileRequests }
  }, [messages, pendingUserMessage])

  // Merge SSE-based and message-based pending requests (dedupe by toolUseId)
  // Only include message-based requests when session is active (for page refresh recovery)
  // When session is idle, message-based requests represent interrupted/completed work
  const pendingSecretRequests = useMemo(() => {
    const seen = new Set<string>()
    const merged: { toolUseId: string; secretName: string; reason?: string }[] = []

    const messageBased = isActive ? messagesBasedPendingRequests.secretRequests : []
    for (const req of [...sseSecretRequests, ...messageBased]) {
      if (!seen.has(req.toolUseId)) {
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
      if (!seen.has(req.toolUseId)) {
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
      if (!seen.has(req.toolUseId)) {
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
      if (!seen.has(req.toolUseId)) {
        seen.add(req.toolUseId)
        merged.push(req)
      }
    }
    return merged
  }, [sseFileRequests, messagesBasedPendingRequests.fileRequests, isActive])

  const scrollRef = useRef<HTMLDivElement>(null)

  // Handler to remove a completed secret request
  const handleSecretRequestComplete = useCallback(
    (toolUseId: string) => {
      removeSecretRequest(sessionId, toolUseId)
    },
    [sessionId]
  )

  // Handler to remove a completed connected account request
  const handleConnectedAccountRequestComplete = useCallback(
    (toolUseId: string) => {
      removeConnectedAccountRequest(sessionId, toolUseId)
    },
    [sessionId]
  )

  // Handler to remove a completed question request
  const handleQuestionRequestComplete = useCallback(
    (toolUseId: string) => {
      removeQuestionRequest(sessionId, toolUseId)
    },
    [sessionId]
  )

  // Handler to remove a completed file request
  const handleFileRequestComplete = useCallback(
    (toolUseId: string) => {
      removeFileRequest(sessionId, toolUseId)
    },
    [sessionId]
  )

  // Check if streaming message is already in persisted messages (prevents double-render)
  const isStreamingMessagePersisted = useMemo(() => {
    if (!streamingMessage || !messages?.length) return false

    // Find the last assistant message
    const lastAssistantMessage = [...messages].reverse().find(m => m.type === 'assistant')
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

  // Auto-scroll to bottom when new messages arrive or requests appear
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, pendingUserMessage, streamingMessage, streamingToolUse, pendingSecretRequests, pendingConnectedAccountRequests, pendingQuestionRequests, pendingFileRequests])

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="overflow-y-auto" ref={scrollRef} data-testid="message-list">
      <div className="p-4 space-y-4">
        {messages?.map((message) => (
          <MessageItem key={message.id} message={message} agentSlug={agentSlug} />
        ))}

        {/* Pending user message - shown immediately after sending */}
        {pendingUserMessage && (
          <MessageItem
            message={{
              id: 'pending-user-message',
              type: 'user',
              content: { text: pendingUserMessage },
              toolCalls: [],
              createdAt: new Date(),
            }}
          />
        )}

        {/* Streaming text message - only show if not already persisted */}
        {isStreaming && streamingMessage && !isStreamingMessagePersisted && (
          <MessageItem
            message={{
              id: 'streaming',
              type: 'assistant',
              content: { text: streamingMessage },
              toolCalls: [],
              createdAt: new Date(),
            }}
            isStreaming
          />
        )}

        {/* Tool use streaming - show partial input as it streams */}
        {isStreaming && streamingToolUse && !streamingMessage && (
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

        {/* Pending secret requests from the agent */}
        {pendingSecretRequests.map((request) => (
          <SecretRequestItem
            key={request.toolUseId}
            toolUseId={request.toolUseId}
            secretName={request.secretName}
            reason={request.reason}
            sessionId={sessionId}
            agentSlug={agentSlug}
            onComplete={() => handleSecretRequestComplete(request.toolUseId)}
          />
        ))}

        {/* Pending connected account requests from the agent */}
        {pendingConnectedAccountRequests.map((request) => (
          <ConnectedAccountRequestItem
            key={request.toolUseId}
            toolUseId={request.toolUseId}
            toolkit={request.toolkit}
            reason={request.reason}
            sessionId={sessionId}
            agentSlug={agentSlug}
            onComplete={() => handleConnectedAccountRequestComplete(request.toolUseId)}
          />
        ))}

        {/* Pending question requests from the agent */}
        {pendingQuestionRequests.map((request) => (
          <QuestionRequestItem
            key={request.toolUseId}
            toolUseId={request.toolUseId}
            questions={request.questions}
            sessionId={sessionId}
            agentSlug={agentSlug}
            onComplete={() => handleQuestionRequestComplete(request.toolUseId)}
          />
        ))}

        {/* Pending file requests from the agent */}
        {pendingFileRequests.map((request) => (
          <FileRequestItem
            key={request.toolUseId}
            toolUseId={request.toolUseId}
            description={request.description}
            fileTypes={request.fileTypes}
            sessionId={sessionId}
            agentSlug={agentSlug}
            onComplete={() => handleFileRequestComplete(request.toolUseId)}
          />
        ))}
      </div>
    </div>
  )
}
