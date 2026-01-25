
import { cn } from '@shared/lib/utils/cn'
import { User, Bot } from 'lucide-react'
import { ToolCallItem } from './tool-call-item'
import ReactMarkdown from 'react-markdown'
import type { ApiMessage, ApiToolCall } from '@shared/lib/types/api'

// Re-export for use by other components
export type { ApiToolCall }

interface MessageItemProps {
  message: ApiMessage
  isStreaming?: boolean
}

export function MessageItem({ message, isStreaming }: MessageItemProps) {
  const isUser = message.type === 'user'
  const isAssistant = message.type === 'assistant'

  const text = message.content.text
  const hasText = text && text.length > 0
  const toolCalls = message.toolCalls || []

  // Skip rendering empty assistant messages (only tool calls, no text)
  // unless streaming. The tool calls will still be rendered below
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
          isAssistant && 'bg-muted'
        )}
      >
        {isUser && <User className="h-4 w-4" />}
        {isAssistant && <Bot className="h-4 w-4" />}
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
              isAssistant && 'bg-muted'
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
                  {text}
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
          </div>
        )}

        {/* Tool calls - shown below assistant message */}
        {isAssistant && toolCalls.length > 0 && (
          <div className="w-full space-y-2">
            {toolCalls.map((toolCall) => (
              <ToolCallItem key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
