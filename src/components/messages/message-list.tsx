'use client'

import { useMessages } from '@/lib/hooks/use-messages'
import { useMessageStream } from '@/lib/hooks/use-message-stream'
import { MessageItem } from './message-item'
import { StreamingToolCallItem } from './tool-call-item'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Wrench } from 'lucide-react'
import { useEffect, useRef } from 'react'

interface MessageListProps {
  sessionId: string
}

export function MessageList({ sessionId }: MessageListProps) {
  const { data: messages, isLoading } = useMessages(sessionId)
  const { streamingMessage, isStreaming, streamingToolUse } = useMessageStream(sessionId)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streamingMessage, streamingToolUse])

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1" ref={scrollRef}>
      <div className="p-4 space-y-4">
        {messages?.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}

        {/* Streaming text message */}
        {isStreaming && streamingMessage && (
          <MessageItem
            message={{
              id: 'streaming',
              sessionId,
              type: 'assistant',
              content: { text: streamingMessage },
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
      </div>
    </ScrollArea>
  )
}
