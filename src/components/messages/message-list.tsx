'use client'

import { useMessages } from '@/lib/hooks/use-messages'
import {
  useMessageStream,
  removeSecretRequest,
  removeConnectedAccountRequest,
} from '@/lib/hooks/use-message-stream'
import { MessageItem } from './message-item'
import { StreamingToolCallItem } from './tool-call-item'
import { SecretRequestItem } from './secret-request-item'
import { ConnectedAccountRequestItem } from './connected-account-request-item'
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
  useEffect(() => {
    if (pendingUserMessage && messages?.length) {
      const found = messages.some(
        (m) => m.type === 'user' && m.content.text === pendingUserMessage
      )
      if (found) {
        onPendingMessageAppeared?.()
      }
    }
  }, [messages, pendingUserMessage, onPendingMessageAppeared])
  const {
    streamingMessage,
    isStreaming,
    streamingToolUse,
    pendingSecretRequests,
    pendingConnectedAccountRequests,
  } = useMessageStream(sessionId)
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
  }, [messages, pendingUserMessage, streamingMessage, streamingToolUse, pendingSecretRequests, pendingConnectedAccountRequests])

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="overflow-y-auto" ref={scrollRef}>
      <div className="p-4 space-y-4">
        {messages?.map((message) => (
          <MessageItem key={message.id} message={message} />
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
            onComplete={() => handleConnectedAccountRequestComplete(request.toolUseId)}
          />
        ))}
      </div>
    </div>
  )
}
