'use client'

import { cn } from '@/lib/utils/cn'
import type { Message } from '@/lib/db/schema'
import { User, Bot, Info, AlertCircle } from 'lucide-react'

interface MessageItemProps {
  message: Message | {
    id: string
    sessionId: string
    type: 'user' | 'assistant' | 'system' | 'result'
    content: any
    createdAt: Date
  }
  isStreaming?: boolean
}

export function MessageItem({ message, isStreaming }: MessageItemProps) {
  const content = typeof message.content === 'string'
    ? JSON.parse(message.content)
    : message.content

  const isUser = message.type === 'user'
  const isAssistant = message.type === 'assistant'
  const isSystem = message.type === 'system'
  const isResult = message.type === 'result'

  return (
    <div
      className={cn(
        'flex gap-3',
        isUser && 'flex-row-reverse'
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'h-8 w-8 rounded-full flex items-center justify-center shrink-0',
          isUser && 'bg-primary text-primary-foreground',
          isAssistant && 'bg-muted',
          isSystem && 'bg-blue-100 text-blue-600',
          isResult && 'bg-green-100 text-green-600'
        )}
      >
        {isUser && <User className="h-4 w-4" />}
        {isAssistant && <Bot className="h-4 w-4" />}
        {isSystem && <Info className="h-4 w-4" />}
        {isResult && <AlertCircle className="h-4 w-4" />}
      </div>

      {/* Message content */}
      <div
        className={cn(
          'flex-1 max-w-[80%]',
          isUser && 'flex justify-end'
        )}
      >
        <div
          className={cn(
            'rounded-lg px-4 py-2',
            isUser && 'bg-primary text-primary-foreground',
            isAssistant && 'bg-muted',
            isSystem && 'bg-blue-50 text-blue-800 text-sm',
            isResult && 'bg-green-50 text-green-800 text-sm'
          )}
        >
          {/* Text content */}
          {content.text && (
            <p className="whitespace-pre-wrap break-words">
              {content.text}
              {isStreaming && (
                <span className="inline-block w-2 h-4 bg-current ml-0.5 animate-pulse" />
              )}
            </p>
          )}

          {/* Tool calls */}
          {content.toolCalls && content.toolCalls.length > 0 && (
            <div className="mt-2 text-xs opacity-70">
              {content.toolCalls.map((tool: any, i: number) => (
                <div key={i} className="font-mono">
                  {tool.name}()
                </div>
              ))}
            </div>
          )}

          {/* System message info */}
          {isSystem && content.subtype && (
            <div className="font-mono text-xs">
              [{content.subtype}]
            </div>
          )}

          {/* Result message */}
          {isResult && (
            <div className="font-mono text-xs">
              {content.is_error ? 'Error' : 'Completed'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
