import { cn } from '@shared/lib/utils/cn'
import { formatCompactDistance } from '@renderer/components/connections/utils'
import type { ReactNode } from 'react'

// Shared building blocks for tool-call renderers. Keeps the card typography
// (label tracking, neutral bg-background boxes, error/success text colors)
// in one place so a style tweak is a one-line change instead of ~20 edits.

const BOX = 'bg-background rounded p-2 text-xs'

/** Uppercase-tracked section label shown above a field box. */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="text-xs font-medium tracking-wider text-muted-foreground mb-1">{children}</div>
}

/** Labeled neutral box for a simple text field (Message, Reason, Server, …). */
export function Field({
  label,
  children,
  className,
}: {
  label: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className={cn(BOX, className)}>{children}</div>
    </div>
  )
}

/** Labeled result box; success = green text, error = red text. */
export function ResultField({
  label = 'Result',
  result,
  isError,
}: {
  label?: string
  result: ReactNode
  isError?: boolean
}) {
  return (
    <Field
      label={isError ? 'Error' : label}
      className={isError ? 'text-red-800 dark:text-red-200' : 'text-green-800 dark:text-green-200'}
    >
      {result}
    </Field>
  )
}

/** Raw <pre> output block; error = red text, otherwise neutral foreground. */
export function ResultBlock({ result, isError }: { result?: string | null; isError?: boolean }) {
  if (!result) return null
  return (
    <pre className={cn('whitespace-pre-wrap', BOX, isError ? 'text-red-800 dark:text-red-200' : 'text-foreground/90')}>
      {result}
    </pre>
  )
}

/**
 * Web tool results are written by the pages they came from, so any markdown in them can point
 * an image anywhere. Loading one would issue an outbound request with a URL the page chose, on
 * every card render. The alt text stands in instead, so a figure that carried meaning still
 * reads as having been there. An empty alt is the page calling the image decorative, and real
 * pages string several of those together, so those drop out entirely rather than leaving a run
 * of placeholders. Links themselves survive - they go through markdownUrlTransform and need a
 * click.
 *
 * Accepted edge: a link whose only content is an image with no alt renders as an empty anchor,
 * so it is not visible or clickable. 8 results out of ~1,000 real transcripts have that shape.
 * Detecting it needs an `a` override, which cost more complexity than the case is worth.
 */
export const NO_MARKDOWN_IMAGES = {
  img: ({ alt }: { alt?: string }) =>
    alt ? <span className="text-muted-foreground/70 italic">[image: {alt}]</span> : null,
}

/**
 * Domain and relative publish age shown beside a web source title. Both web renderers
 * use it, so the pair can't drift apart. An unparseable date yields '' and renders nothing.
 */
export function SourceMeta({ host, publishedDate }: { host: string | null; publishedDate?: string }) {
  const age = publishedDate ? formatCompactDistance(new Date(publishedDate)) : ''
  return (
    <>
      {host && <span className="text-muted-foreground shrink-0">{host}</span>}
      {age && (
        <span className="text-muted-foreground/70 shrink-0" title={publishedDate}>
          {age}
        </span>
      )}
    </>
  )
}

/**
 * Canonical glyph for task/todo item status (TodoWrite, TaskUpdate).
 * Single source of truth so the ✓/→/○ glyphs and their colors don't drift
 * across renderers. Green aligns with StatusIndicator's success token.
 */
export function TaskStatusIcon({ status }: { status?: string }) {
  if (status === 'completed') return <span className="text-green-600 dark:text-green-400">✓</span>
  if (status === 'in_progress') return <span className="text-blue-500">→</span>
  return <span className="text-muted-foreground">○</span>
}
