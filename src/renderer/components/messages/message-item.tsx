
import { cn } from '@shared/lib/utils/cn'
import { User, Bot } from 'lucide-react'
import { ToolCallItem } from './tool-call-item'
import { MessageContextMenu } from './message-context-menu'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ApiMessage, ApiToolCall } from '@shared/lib/types/api'

// Re-export for use by other components
export type { ApiToolCall }

interface MessageItemProps {
  message: ApiMessage
  isStreaming?: boolean
  agentSlug?: string
  isSessionActive?: boolean
  onRemoveMessage?: (messageId: string) => void
  onRemoveToolCall?: (toolCallId: string) => void
}

export function MessageItem({ message, isStreaming, agentSlug, isSessionActive, onRemoveMessage, onRemoveToolCall }: MessageItemProps) {
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
      data-testid={isUser ? 'message-user' : isAssistant ? 'message-assistant' : undefined}
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
          <MessageContextMenu text={text || ''} onRemove={onRemoveMessage ? () => onRemoveMessage(message.id) : undefined}>
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
                  // prose-user-message resets prose-invert in dark mode where primary bg is light
                  isUser ? 'prose-invert prose-user-message' : 'dark:prose-invert'
                )}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      // Style code blocks
                      pre: ({ children }) => (
                        <pre className={cn(
                          'rounded p-2 overflow-x-auto text-xs',
                          isUser ? 'bg-white/20 dark:bg-black/10' : 'bg-background/50'
                        )}>
                          {children}
                        </pre>
                      ),
                      code: ({ children, className }) => {
                        const isInline = !className
                        return isInline ? (
                          <code className={cn(
                            'rounded px-1 py-0.5 text-xs',
                            isUser ? 'bg-white/20 dark:bg-black/10' : 'bg-background/50'
                          )}>
                            {children}
                          </code>
                        ) : (
                          <code className={className}>{children}</code>
                        )
                      },
                      // Style tables with borders and horizontal scroll
                      table: ({ children }) => (
                        <div className="overflow-x-auto">
                          <table className="w-full border-collapse text-sm">
                            {children}
                          </table>
                        </div>
                      ),
                      th: ({ children }) => (
                        <th className={cn(
                          'border-b-2 px-3 py-1.5 text-left font-semibold',
                          isUser ? 'border-white/30 dark:border-black/20' : 'border-border'
                        )}>
                          {children}
                        </th>
                      ),
                      td: ({ children }) => (
                        <td className={cn(
                          'border-b px-3 py-1.5',
                          isUser ? 'border-white/20 dark:border-black/10' : 'border-border'
                        )}>
                          {children}
                        </td>
                      ),
                      // Ensure links open in new tab
                      a: ({ children, href }) => (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn(
                            'hover:underline',
                            isUser ? 'text-blue-200 dark:text-blue-600' : 'text-blue-500'
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
          </MessageContextMenu>
        )}

        {/* Tool calls - shown below assistant message */}
        {isAssistant && toolCalls.length > 0 && (
          <div className="w-full space-y-2">
            {toolCalls.map((toolCall) => (
              <MessageContextMenu key={toolCall.id} text={toolCall.name} onRemove={onRemoveToolCall ? () => onRemoveToolCall(toolCall.id) : undefined}>
                <div>
                  <ToolCallItem toolCall={toolCall} messageCreatedAt={message.createdAt} agentSlug={agentSlug} isSessionActive={isSessionActive} />
                </div>
              </MessageContextMenu>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
