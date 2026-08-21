import { cn } from '@shared/lib/utils/cn'
import { ListTree, ChevronDown, ChevronRight } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useElapsedTimer, formatElapsed } from '@renderer/hooks/use-elapsed-timer'
import { markdownUrlTransform } from '@renderer/lib/markdown-url-transform'
import { StatusIndicator } from './tool-call-item'
import { splitStreamingMarkdown } from './split-streaming-markdown'

interface ThinkingBlockItemProps {
  text: string
  /** True while this block is the one currently streaming reasoning text. */
  active: boolean
  /**
   * Live-stream timing (ms epoch). Present for stream-state blocks so the
   * header can show a live timer / "Thought for Ns"; absent for blocks read
   * back from the persisted transcript.
   */
  startedAt?: number
  /** null while the live block is still streaming */
  endedAt?: number | null
  /** Transcript-derived duration for persisted blocks (no live timing). */
  durationMs?: number
}

// How close (px) to the bottom counts as "pinned" — tighter than the message
// list's 80px tolerance since the card body is a small (max-h-64) scroller.
const PIN_THRESHOLD_PX = 32

const THINKING_REMARK_PLUGINS = [remarkGfm]

// Thinking traces use the same safe URL policy as assistant messages. Keep the
// renderer deliberately compact: these blocks live in a narrow, capped card,
// where a wide table should scroll instead of widening the whole transcript.
const THINKING_MARKDOWN_COMPONENTS: Components = {
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-500 hover:underline"
    >
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="code-scrollbar my-2 max-w-full overflow-x-auto">
      <table className="my-0">{children}</table>
    </div>
  ),
}

const ThinkingMarkdownBlock = memo(function ThinkingMarkdownBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={THINKING_REMARK_PLUGINS}
      components={THINKING_MARKDOWN_COMPONENTS}
      urlTransform={markdownUrlTransform}
    >
      {text}
    </ReactMarkdown>
  )
})

/**
 * A thinking episode rendered as a tool-call-style card.
 *
 * While the block streams it is expanded with a scrollable, bottom-pinned body so
 * the trace can be read as it happens; when the block ends it collapses to a
 * "Thought for Ns" header (unless the user toggled it themselves, which wins).
 * Persisted transcript blocks render the same card, collapsed, headed "Thought".
 */
export function ThinkingBlockItem({ text, active, startedAt, endedAt, durationMs }: ThinkingBlockItemProps) {
  // null = follow the default (expanded while active); a user click overrides it
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  const expanded = userExpanded ?? active

  // Memoized so the timer effect doesn't reset its interval on every delta re-render.
  // Live while streaming (endDate null), static "Thought for" duration once done.
  // A block that never got its stop event (interrupted turn, missed idle event)
  // freezes at the elapsed time when `active` flips off, rather than ticking
  // forever or snapping back to 0s. Normally dead code: the stream handlers
  // close open blocks on thinking_start/stop and session_idle.
  const startDate = useMemo(() => (startedAt !== undefined ? new Date(startedAt) : null), [startedAt])
  const endDate = useMemo(() => {
    if (startedAt === undefined) return null
    if (endedAt !== null && endedAt !== undefined) return new Date(endedAt)
    return active ? null : new Date()
  }, [endedAt, active, startedAt])
  const elapsed = useElapsedTimer(startDate, endDate)
  // Live timing wins (exact); persisted blocks fall back to the
  // transcript-derived duration; header degrades to plain "Thought" without either.
  const doneDuration = elapsed ?? (durationMs !== undefined ? formatElapsed(durationMs) : null)

  // As with assistant responses, only re-parse the unfinished tail while text
  // streams. Completed Markdown blocks remain memoized instead of making a long
  // reasoning trace progressively more expensive on every delta.
  const streamingSplit = active && text ? splitStreamingMarkdown(text) : null

  // Stick-to-bottom: follow the streaming text unless the user scrolls up to read.
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (active && expanded && el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [text, active, expanded])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX
  }

  return (
    <div className="text-sm border border-border/70 rounded-md overflow-hidden" data-testid="thinking-block">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} thinking`}
        data-testid="thinking-block-toggle"
        onClick={() => setUserExpanded(!expanded)}
        className={cn('flex w-full items-center gap-2 pl-2 pr-2 py-1.5 group hover:bg-muted/50 transition-colors', expanded && 'bg-muted/50')}
      >
        <ListTree className={cn(
          'h-3.5 w-3.5 shrink-0 transition-colors',
          active ? 'text-foreground' : 'text-foreground/45 group-hover:text-foreground'
        )} />
        <span className={cn(
          'font-sans font-normal shrink-0 text-sm leading-none transition-colors',
          active ? 'text-foreground' : 'text-foreground/65 group-hover:text-foreground'
        )}>
          {active ? 'Thinking' : doneDuration ? `Thought for ${doneDuration}` : 'Thought'}
        </span>
        {active && elapsed && (
          <span className="shrink-0 text-2xs text-muted-foreground/70 tabular-nums ml-auto">
            {elapsed}
          </span>
        )}
        {active ? (
          <span className={cn('relative shrink-0 flex h-4 w-4 items-center justify-center', !elapsed && 'ml-auto')}>
            <span className="transition-opacity group-hover:opacity-0">
              <StatusIndicator status="running" />
            </span>
            <span className="absolute inset-0 flex items-center justify-center text-muted-foreground/60 opacity-0 transition-opacity group-hover:text-muted-foreground group-hover:opacity-100">
              {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </span>
          </span>
        ) : (
          <span className="shrink-0 flex h-4 w-4 items-center justify-center ml-auto text-muted-foreground/60 group-hover:text-muted-foreground transition-colors">
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
        )}
      </button>

      {expanded && (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="border-t border-border/70 bg-muted/50 px-3 py-2 max-h-64 overflow-y-auto"
          data-testid="thinking-block-body"
        >
          <div
            dir="auto"
            className={cn(
              'prose prose-sm max-w-none min-w-0 break-words select-text text-xs text-muted-foreground dark:prose-invert',
              'prose-headings:my-2 prose-headings:text-sm prose-headings:font-medium prose-headings:leading-snug',
              'prose-p:my-2 prose-p:text-xs prose-p:leading-relaxed prose-li:my-0 prose-li:text-xs',
              'prose-ul:my-2 prose-ol:my-2 prose-strong:font-medium prose-strong:text-current',
              'prose-blockquote:my-2 prose-blockquote:text-current',
              'prose-pre:my-2 prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:border prose-pre:border-border/70 prose-pre:bg-background/60 prose-pre:p-2',
              'prose-code:rounded prose-code:bg-black/[0.05] prose-code:px-1 prose-code:py-0.5 prose-code:text-xs prose-code:font-normal prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none dark:prose-code:bg-white/[0.08]',
              '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0'
            )}
            data-testid="thinking-markdown"
          >
            {!text ? (
              <span className="italic">Thinking…</span>
            ) : streamingSplit ? (
              <>
                {streamingSplit.settled.map((block, i) => (
                  <ThinkingMarkdownBlock key={i} text={block} />
                ))}
                {streamingSplit.tail && <ThinkingMarkdownBlock text={streamingSplit.tail} />}
              </>
            ) : (
              <ThinkingMarkdownBlock text={text} />
            )}
            {active && <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-current align-text-bottom" />}
          </div>
        </div>
      )}
    </div>
  )
}
