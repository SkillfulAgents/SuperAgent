'use client'

import { cn } from '@/lib/utils/cn'
import type { Message, ToolCall } from '@/lib/db/schema'
import { User, Bot, Info, AlertCircle, StopCircle } from 'lucide-react'
import { ToolCallItem } from './tool-call-item'
import ReactMarkdown from 'react-markdown'

interface MessageItemProps {
  message: (Message & { toolCalls?: ToolCall[] }) | {
    id: string
    sessionId: string
    type: 'user' | 'assistant' | 'system' | 'result'
    content: any
    createdAt: Date
    toolCalls?: ToolCall[]
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
  const isInterrupted = isSystem && content.subtype === 'interrupted'

  const hasText = content.text && content.text.length > 0

  // Skip rendering empty assistant messages (only tool calls, no text)
  // The tool calls will still be rendered below
  const showMessageBubble = !isAssistant || hasText || isStreaming

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
          isInterrupted && 'bg-amber-100 text-amber-600',
          isSystem && !isInterrupted && 'bg-blue-100 text-blue-600',
          isResult && 'bg-green-100 text-green-600'
        )}
      >
        {isUser && <User className="h-4 w-4" />}
        {isAssistant && <Bot className="h-4 w-4" />}
        {isInterrupted && <StopCircle className="h-4 w-4" />}
        {isSystem && !isInterrupted && <Info className="h-4 w-4" />}
        {isResult && <AlertCircle className="h-4 w-4" />}
      </div>

      {/* Message content */}
      <div
        className={cn(
          'flex-1 max-w-[80%] flex flex-col gap-2',
          isUser && 'items-end'
        )}
      >
        {/* Message bubble - only show if there's text content */}
        {showMessageBubble && (
          <div
            className={cn(
              'rounded-lg px-4 py-2',
              isUser && 'bg-primary text-primary-foreground',
              isAssistant && 'bg-muted',
              isInterrupted && 'bg-amber-50 text-amber-800 text-sm',
              isSystem && !isInterrupted && 'bg-blue-50 text-blue-800 text-sm',
              isResult && 'bg-green-50 text-green-800 text-sm'
            )}
          >
            {/* Text content */}
            {hasText && (
              <div className={cn(
                'prose prose-sm max-w-none break-words',
                // Use inverted (light) text for user messages (dark bg) and dark mode
                isUser ? 'prose-invert' : 'dark:prose-invert'
              )}>
                <ReactMarkdown
                  components={{
                    // Style code blocks
                    pre: ({ children }) => (
                      <pre className={cn(
                        'rounded p-2 overflow-x-auto text-xs',
                        isUser ? 'bg-white/20' : 'bg-background/50'
                      )}>
                        {children}
                      </pre>
                    ),
                    code: ({ children, className }) => {
                      const isInline = !className
                      return isInline ? (
                        <code className={cn(
                          'rounded px-1 py-0.5 text-xs',
                          isUser ? 'bg-white/20' : 'bg-background/50'
                        )}>
                          {children}
                        </code>
                      ) : (
                        <code className={className}>{children}</code>
                      )
                    },
                    // Ensure links open in new tab
                    a: ({ children, href }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                          'hover:underline',
                          isUser ? 'text-blue-200' : 'text-blue-500'
                        )}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {content.text}
                </ReactMarkdown>
                {isStreaming && (
                  <span className="inline-block w-2 h-4 bg-current ml-0.5 animate-pulse" />
                )}
              </div>
            )}

            {/* Streaming indicator when no text yet */}
            {!hasText && isStreaming && (
              <span className="inline-block w-2 h-4 bg-current animate-pulse" />
            )}

            {/* Interrupted message */}
            {isInterrupted && (
              <div className="font-mono text-xs">
                Stopped by user
              </div>
            )}

            {/* System message info */}
            {isSystem && !isInterrupted && content.subtype && (
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
        )}

        {/* Tool calls - shown below assistant message */}
        {isAssistant && message.toolCalls && message.toolCalls.length > 0 && (
          <div className="w-full space-y-2">
            {message.toolCalls.map((toolCall) => (
              <ToolCallItem key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
