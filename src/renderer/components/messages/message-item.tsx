import { cn } from '@shared/lib/utils/cn'
import { useState, useCallback, useRef, useLayoutEffect, memo, type ReactNode } from 'react'
import { Check, Copy, Link2 } from 'lucide-react'
import { ProviderErrorCard } from '@renderer/components/ui/provider-error-card'
import { InsufficientBalanceCard, usePlatformBillingUrl } from './insufficient-balance-card'
import { ToolCallItem } from './tool-call-item'
import { ThinkingBlockItem } from './thinking-block-item'
import { SubAgentBlock } from './subagent-block'
import { WorkflowBlock } from './workflow-block'
import { WorkflowResultCard } from './workflow-result-card'
import { parseTaskNotifications } from '@shared/lib/utils/task-notifications'
import { MessageContextMenu } from './message-context-menu'
import { MessageErrorBoundary } from './message-error-boundary'
import { FileDownloadPill } from '@renderer/components/ui/file-download-pill'
import { parseAttachedFiles, parseMountedFolders } from '@shared/lib/utils/attached-files'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitStreamingMarkdown } from './split-streaming-markdown'
import { PROVIDER_ERROR_CODES } from '@shared/lib/types/api'
import type { ApiMessage, ApiToolCall } from '@shared/lib/types/api'
import type { SubagentInfo } from '@renderer/hooks/use-message-stream'
import { useRenderTracker } from '@renderer/lib/perf'
import { markdownUrlTransform } from '@renderer/lib/markdown-url-transform'

// Re-export for use by other components
export type { ApiToolCall }

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    const text = extractText(children)
    void navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [children])

  return (
    <pre className={cn(
      'relative group rounded-md p-3 text-sm leading-relaxed border code-scrollbar',
      'bg-black/[0.03] dark:bg-white/[0.06] border-border/60 text-foreground'
    )}>
      <button
        onClick={handleCopy}
        className={cn(
          'absolute top-2 right-2 p-1 rounded',
          'opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity',
          'hover:bg-black/[0.1] dark:hover:bg-white/[0.15]',
          'text-muted-foreground'
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {children}
    </pre>
  )
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) return extractText(node.props.children)
  return ''
}

const REMARK_PLUGINS = [remarkGfm]

// Side breathing room kept between an expanded table and the chat edges.
const TABLE_BREAKOUT_GUTTER = 16

// A wide (many-column) table shouldn't be crammed into the narrow readable text
// column. Like Notion, we let a table that's wider than the column break out and
// centre itself across the available chat width, scrolling horizontally only
// once it still exceeds that. Narrow tables are left untouched in the normal
// text flow. The breakout is measured rather than pure-CSS because the table is
// nested several constrained, off-centre ancestors deep, so there is no static
// containing block to anchor a symmetric breakout to. Only assistant messages
// opt in (via `data-allow-table-breakout`); elsewhere the table just scrolls
// inside its own column.
function ExpandingTable({ children }: { children: ReactNode }) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current
    const scroller = scrollerRef.current
    if (!wrapper || !scroller) return

    const contentArea = wrapper.closest('[data-message-content-area]') as HTMLElement | null
    const canBreakOut = !!wrapper.closest('[data-allow-table-breakout]')

    const measure = () => {
      // Always start from the natural in-flow geometry before deciding.
      wrapper.style.width = ''
      wrapper.style.marginLeft = ''

      if (!contentArea || !canBreakOut) return

      const columnWidth = wrapper.clientWidth
      const naturalWidth = scroller.scrollWidth
      // Only break out when the table genuinely wants more than the column.
      if (naturalWidth <= columnWidth + 1) return

      const available = contentArea.clientWidth - TABLE_BREAKOUT_GUTTER * 2
      if (available <= columnWidth) return // window too narrow to gain anything

      const target = Math.min(naturalWidth, available)
      const areaLeft = contentArea.getBoundingClientRect().left + TABLE_BREAKOUT_GUTTER
      const currentLeft = wrapper.getBoundingClientRect().left
      const desiredLeft = areaLeft + (available - target) / 2

      wrapper.style.width = `${target}px`
      wrapper.style.marginLeft = `${desiredLeft - currentLeft}px`
    }

    measure()

    if (!contentArea || typeof ResizeObserver === 'undefined') return
    // Re-centre when the chat area resizes. Content changes (e.g. a table still
    // streaming) re-run this effect via the `children` dependency, so we don't
    // observe the table itself — that would risk a resize-observer feedback loop.
    const observer = new ResizeObserver(() => measure())
    observer.observe(contentArea)
    return () => observer.disconnect()
  }, [children])

  return (
    <div ref={wrapperRef} className="my-3" data-testid="markdown-table">
      <div ref={scrollerRef} className="code-scrollbar overflow-x-auto">
        <table className="w-max min-w-full border-collapse text-sm">
          {children}
        </table>
      </div>
    </div>
  )
}

// Hoisted to a stable module-level reference. The memoized <MarkdownBlock> below
// must NOT be handed a fresh `components`/`remarkPlugins` object each render, or
// its memo would never bail and every settled streaming block would re-parse.
const MARKDOWN_COMPONENTS: Components = {
  // Style code blocks
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children, className }) => {
    const isInline = !className
    return isInline ? (
      <code className={cn(
        'rounded px-1.5 py-0.5 text-sm font-medium',
        'bg-black/[0.05] dark:bg-white/[0.08] text-foreground'
      )}>
        {children}
      </code>
    ) : (
      <code className={cn(className, 'text-foreground')}>{children}</code>
    )
  },
  // Wide tables expand beyond the readable column and scroll; see ExpandingTable.
  table: ({ children }) => <ExpandingTable>{children}</ExpandingTable>,
  // Cap individual cell width so prose-heavy cells wrap instead of stretching the
  // table to one giant line, while many short columns still drive the breakout.
  th: ({ children }) => (
    <th className={cn(
      'border-b-2 px-3 py-1.5 text-left font-semibold align-top',
      'border-border'
    )}>
      <div className="max-w-[32rem]">{children}</div>
    </th>
  ),
  td: ({ children }) => (
    <td className={cn(
      'border-b px-3 py-1.5 align-top',
      'border-border'
    )}>
      <div className="max-w-[32rem]">{children}</div>
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
}

// A single markdown block. Memoized so that, while a response streams, each
// already-settled block parses exactly once even though later deltas keep
// re-rendering the parent MessageItem. See split-streaming-markdown.ts.
// Exported so the agent-markdown link/scheme handling can be tested directly
// (SUP-238) without standing up a full MessageItem.
export const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS} urlTransform={markdownUrlTransform}>
      {text}
    </ReactMarkdown>
  )
})

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

function MessageItemComponent({ message, isStreaming, agentSlug, sessionId, isSessionActive, activeSubagents, completedSubagents, onRemoveMessage, onRemoveToolCall }: MessageItemProps) {
  useRenderTracker('MessageItem')
  const isUser = message.type === 'user'
  const isAssistant = message.type === 'assistant'

  const rawText = message.content.text
  const { cleanText: textAfterFiles, attachedFiles } = isUser && rawText ? parseAttachedFiles(rawText) : { cleanText: rawText, attachedFiles: [] }
  const { cleanText, mountedFolders } = isUser && textAfterFiles ? parseMountedFolders(textAfterFiles) : { cleanText: textAfterFiles, mountedFolders: [] }
  // Strip SDK-injected `<task-notification>` blocks that land in assistant text on
  // the busy path; surface any `workflow-complete` result as a structured card.
  const { cleanText: textAfterNotifs, workflowResults } = isAssistant && cleanText
    ? parseTaskNotifications(cleanText)
    : { cleanText, workflowResults: [] }
  const text = textAfterNotifs
  const hasText = text && text.length > 0
  const toolCalls = message.toolCalls || []
  // Persisted extended-thinking text. Defensive shape check — this field
  // crosses the wire, and empty strings are real data in older transcripts.
  const thinking = isAssistant && Array.isArray(message.thinking)
    ? message.thinking.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : []

  const isSlashCommand = isUser && hasText && text.startsWith('/')

  // While streaming, pre-split the markdown into fence-safe blocks so each
  // settled block parses once; only the small trailing block re-parses per
  // delta (O(N) instead of O(N^2)). Persisted messages render as one document.
  const streamingSplit = isStreaming && text ? splitStreamingMarkdown(text) : null

  // Detect assistant messages that failed due to an LLM provider error (from SDK metadata)
  const isProviderErrorMessage = isAssistant && !!message.apiError && PROVIDER_ERROR_CODES.has(message.apiError)
  const billingUrl = usePlatformBillingUrl(rawText ?? '')
  const showBillingCard = isAssistant && !!message.apiError && !!billingUrl

  // Don't render assistant messages that have no text, no tool calls, and no
  // thinking (and aren't streaming). These are transient empty entries from
  // partially-persisted JSONL that will be filled in on the next refetch.
  if (isAssistant && !hasText && toolCalls.length === 0 && thinking.length === 0 && !isStreaming) {
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
        isUser && 'flex-row-reverse !my-6'
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

        {/* Persisted thinking — collapsed cards above the message text, one per
            episode. Same card the live stream uses, minus timing (the transcript
            doesn't carry it). */}
        {thinking.length > 0 && (
          <div className="w-full space-y-2">
            {thinking.map((t, i) => (
              <MessageErrorBoundary key={i} kind="thinking block" raw={t} itemId={`${message.id}-thinking-${i}`}>
                <ThinkingBlockItem text={t} active={false} />
              </MessageErrorBoundary>
            ))}
          </div>
        )}

        {/* Message bubble - only show if there's text content */}
        {showMessageBubble && (
          <MessageContextMenu text={text || ''} onRemove={onRemoveMessage ? () => onRemoveMessage(message.id) : undefined}>
            <div
              dir="auto"
              // Assistant bubbles opt into table breakout and must not clip it.
              data-allow-table-breakout={isAssistant ? '' : undefined}
              className={cn(
                'rounded-lg max-w-full text-foreground',
                !isAssistant && 'overflow-hidden',
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

              {/* Actionable platform billing error */}
              {hasText && !isSlashCommand && showBillingCard && (
                <InsufficientBalanceCard billingUrl={billingUrl!} />
              )}

              {/* LLM provider error display */}
              {hasText && !isSlashCommand && !showBillingCard && isProviderErrorMessage && (
                <ProviderErrorCard message={text} />
              )}

              {/* Text content */}
              {hasText && !isSlashCommand && !showBillingCard && !isProviderErrorMessage && (
                <div dir="auto" className={cn(
                  'prose prose-sm max-w-none min-w-0 break-words font-normal dark:prose-invert',
                  'prose-strong:font-medium'
                )}>
                  {streamingSplit ? (
                    <>
                      {streamingSplit.settled.map((block, i) => (
                        <MarkdownBlock key={i} text={block} />
                      ))}
                      {streamingSplit.tail && <MarkdownBlock text={streamingSplit.tail} />}
                    </>
                  ) : (
                    <MarkdownBlock text={text} />
                  )}
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
                className="flex items-center gap-1.5 rounded-full border bg-blue-50 dark:bg-blue-500/10 border-blue-200 dark:border-blue-800 px-3 py-1 text-xs"
                title={`Host: ${mount.hostPath}`}
              >
                <Link2 className="h-3 w-3 text-blue-500" />
                <span className="font-medium">{mount.containerPath}</span>
                <span className="text-muted-foreground">mounted</span>
              </div>
            ))}
          </div>
        )}

        {/* Workflow result cards parsed from inline task-notification blocks */}
        {isAssistant && workflowResults.length > 0 && (
          <div className="w-full space-y-2">
            {workflowResults.map((wf, idx) => (
              <WorkflowResultCard key={wf.runId ?? idx} notification={wf} />
            ))}
          </div>
        )}

        {/* Tool calls - shown below assistant message */}
        {isAssistant && toolCalls.length > 0 && (
          <div className="w-full space-y-2">
            {toolCalls.map((toolCall) => (
              <MessageContextMenu key={toolCall.id} text={toolCall.name} onRemove={onRemoveToolCall ? () => onRemoveToolCall(toolCall.id) : undefined}>
                <div>
                  <MessageErrorBoundary kind="tool call" raw={toolCall} itemId={toolCall.id}>
                    {(toolCall.name === 'Task' || toolCall.name === 'Agent') && sessionId ? (
                      <SubAgentBlock
                        toolCall={toolCall}
                        sessionId={sessionId}
                        agentSlug={agentSlug!}
                        isSessionActive={isSessionActive}
                        activeSubagent={activeSubagents?.find(s => s.parentToolId === toolCall.id) ?? null}
                        isCompleted={completedSubagents?.has(toolCall.id) ?? false}
                      />
                    ) : toolCall.name === 'Workflow' ? (
                      <WorkflowBlock
                        toolCall={toolCall}
                        activeSubagent={activeSubagents?.find(s => s.parentToolId === toolCall.id) ?? null}
                        isCompleted={completedSubagents?.has(toolCall.id) ?? false}
                      />
                    ) : (
                      <ToolCallItem toolCall={toolCall} messageCreatedAt={message.createdAt} agentSlug={agentSlug} isSessionActive={isSessionActive} />
                    )}
                  </MessageErrorBoundary>
                </div>
              </MessageContextMenu>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Memoized: on the 5s refetch React Query's structural sharing preserves the
// object reference of any unchanged message, so the default shallow prop compare
// skips re-rendering all but the items that actually changed. Handlers, agentSlug
// and sessionId are referentially stable. Note: activeSubagents/completedSubagents
// are passed to every item and change identity on each subagent SSE event, so the
// memo gives no benefit while a subagent is actively streaming — it still pays off
// for the common idle/refetch and plain-text-streaming cases.
export const MessageItem = memo(MessageItemComponent)

if (__RENDER_TRACKING__) {
  (MessageItem as any).whyDidYouRender = true
}
