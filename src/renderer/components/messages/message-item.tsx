import { cn } from '@shared/lib/utils/cn'
import { Link2 } from 'lucide-react'
import { ProviderErrorCard } from '@renderer/components/ui/provider-error-card'
import { ToolCallItem } from './tool-call-item'
import { SubAgentBlock } from './subagent-block'
import { MessageContextMenu } from './message-context-menu'
import { FileDownloadPill } from '@renderer/components/ui/file-download-pill'
import { parseAttachedFiles, parseMountedFolders } from '@shared/lib/utils/attached-files'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PROVIDER_ERROR_CODES } from '@shared/lib/types/api'
import type { ApiMessage, ApiToolCall } from '@shared/lib/types/api'
import type { SubagentInfo } from '@renderer/hooks/use-message-stream'

// Re-export for use by other components
export type { ApiToolCall }

interface MessageItemProps {
  message: ApiMessage
  isStreaming?: boolean
  agentSlug?: string
  sessionId?: string
  isSessionActive?: boolean
  activeSubagents?: SubagentInfo[]
  completedSubagents?: Set<string> | null
  onRemoveMessage?: (messageId: string) => void
  onRemoveToolCall?: (toolCallId: string) => void
}

export function MessageItem({ message, isStreaming, agentSlug, sessionId, isSessionActive, activeSubagents, completedSubagents, onRemoveMessage, onRemoveToolCall }: MessageItemProps) {
  const isUser = message.type === 'user'
  const isAssistant = message.type === 'assistant'

  const rawText = message.content.text
  const { cleanText: textAfterFiles, attachedFiles } = isUser && rawText ? parseAttachedFiles(rawText) : { cleanText: rawText, attachedFiles: [] }
  const { cleanText, mountedFolders } = isUser && textAfterFiles ? parseMountedFolders(textAfterFiles) : { cleanText: textAfterFiles, mountedFolders: [] }
  const text = cleanText
  const hasText = text && text.length > 0
  const toolCalls = message.toolCalls || []

  const isSlashCommand = isUser && hasText && text.startsWith('/')

  // Detect assistant messages that failed due to an LLM provider error (from SDK metadata)
  const isProviderErrorMessage = isAssistant && !!message.apiError && PROVIDER_ERROR_CODES.has(message.apiError)

  // Don't render assistant messages that have no text and no tool calls
  // (and aren't streaming). These are transient empty entries from partially-
  // persisted JSONL that will be filled in on the next refetch.
  if (isAssistant && !hasText && toolCalls.length === 0 && !isStreaming) {
    return null
  }

  // Skip rendering the text bubble for:
  // - assistant messages with only tool calls (no text) unless streaming
  // - user messages that only had attached files (text was fully stripped)
  const showMessageBubble = isUser
    ? (hasText || attachedFiles.length === 0)
    : (hasText || isStreaming)

  return (
    <div
      className={cn(
        'flex gap-3',
        isUser && 'flex-row-reverse'
      )}
      data-testid={isUser ? 'message-user' : isAssistant ? 'message-assistant' : undefined}
    >
      {/* Message content */}
      <div
        className={cn(
          'flex-1 max-w-[80%] min-w-0 flex flex-col gap-2',
          isUser && 'items-end'
        )}
      >
        {/* Sender name for shared agent sessions */}
        {isUser && message.sender?.name && (
          <span className="text-xs text-muted-foreground">{message.sender.name}</span>
        )}

        {/* Message bubble - only show if there's text content */}
        {showMessageBubble && (
          <MessageContextMenu text={text || ''} onRemove={onRemoveMessage ? () => onRemoveMessage(message.id) : undefined}>
            <div
              className={cn(
                'rounded-lg max-w-full overflow-hidden text-foreground',
                isUser && 'bg-zinc-100 dark:bg-zinc-800/70 px-4 py-2',
                isAssistant && 'py-1'
              )}
            >
              {/* Slash command display */}
              {isSlashCommand && hasText && (
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono font-semibold text-sm">
                    {text.split(' ')[0]}
                  </span>
                  {text.includes(' ') && (
                    <span className="text-sm opacity-80">
                      {text.slice(text.indexOf(' ') + 1)}
                    </span>
                  )}
                </div>
              )}

              {/* LLM provider error display */}
              {hasText && !isSlashCommand && isProviderErrorMessage && (
                <ProviderErrorCard message={text} />
              )}

              {/* Text content */}
              {hasText && !isSlashCommand && !isProviderErrorMessage && (
                <div className={cn(
                  'prose prose-sm max-w-none min-w-0 break-words font-medium dark:prose-invert'
                )}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      // Style code blocks
                      pre: ({ children }) => (
                        <pre className={cn(
                          'rounded-md p-3 overflow-x-auto text-[13px] leading-relaxed border',
                          'bg-black/[0.03] dark:bg-white/[0.06] border-border/60 text-foreground'
                        )}>
                          {children}
                        </pre>
                      ),
                      code: ({ children, className }) => {
                        const isInline = !className
                        return isInline ? (
                          <code className={cn(
                            'rounded px-1.5 py-0.5 text-[13px] font-medium',
                            'bg-black/[0.05] dark:bg-white/[0.08] text-foreground'
                          )}>
                            {children}
                          </code>
                        ) : (
                          <code className={cn(className, 'text-foreground')}>{children}</code>
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
                          'border-border'
                        )}>
                          {children}
                        </th>
                      ),
                      td: ({ children }) => (
                        <td className={cn(
                          'border-b px-3 py-1.5',
                          'border-border'
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
                            'text-blue-500'
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

        {/* Attached file chips for user messages */}
        {isUser && attachedFiles.length > 0 && agentSlug && (
          <div className="flex flex-wrap gap-1.5 justify-end">
            {attachedFiles.map((filePath, idx) => (
              <FileDownloadPill key={idx} filePath={filePath} agentSlug={agentSlug} />
            ))}
          </div>
        )}

        {/* Mounted folder pills for user messages */}
        {isUser && mountedFolders.length > 0 && (
          <div className="flex flex-wrap gap-1.5 justify-end">
            {mountedFolders.map((mount, idx) => (
              <div
                key={idx}
                className="flex items-center gap-1.5 rounded-full border bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 px-3 py-1 text-xs"
                title={`Host: ${mount.hostPath}`}
              >
                <Link2 className="h-3 w-3 text-blue-500" />
                <span className="font-medium">{mount.containerPath}</span>
                <span className="text-muted-foreground">mounted</span>
              </div>
            ))}
          </div>
        )}

        {/* Tool calls - shown below assistant message */}
        {isAssistant && toolCalls.length > 0 && (
          <div className="w-full space-y-2">
            {toolCalls.map((toolCall) => (
              <MessageContextMenu key={toolCall.id} text={toolCall.name} onRemove={onRemoveToolCall ? () => onRemoveToolCall(toolCall.id) : undefined}>
                <div>
                  {(toolCall.name === 'Task' || toolCall.name === 'Agent') && sessionId ? (
                    <SubAgentBlock
                      toolCall={toolCall}
                      sessionId={sessionId}
                      agentSlug={agentSlug!}
                      isSessionActive={isSessionActive}
                      activeSubagent={activeSubagents?.find(s => s.parentToolId === toolCall.id) ?? null}
                      isCompleted={completedSubagents?.has(toolCall.id) ?? false}
                    />
                  ) : (
                    <ToolCallItem toolCall={toolCall} messageCreatedAt={message.createdAt} agentSlug={agentSlug} isSessionActive={isSessionActive} />
                  )}
                </div>
              </MessageContextMenu>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
