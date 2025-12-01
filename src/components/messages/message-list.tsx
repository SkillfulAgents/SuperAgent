'use client'

import { useMessages } from '@/lib/hooks/use-messages'
import { useMessageStream } from '@/lib/hooks/use-message-stream'
import { MessageItem } from './message-item'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2 } from 'lucide-react'
import { useEffect, useRef } from 'react'

interface MessageListProps {
  sessionId: string
}

export function MessageList({ sessionId }: MessageListProps) {
  const { data: messages, isLoading } = useMessages(sessionId)
  const { streamingMessage, isStreaming } = useMessageStream(sessionId)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streamingMessage])

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

        {/* Streaming message */}
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
      </div>
    </ScrollArea>
  )
}
