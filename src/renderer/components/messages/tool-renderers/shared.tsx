import { cn } from '@shared/lib/utils/cn'
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
 * Canonical glyph for task/todo item status (TodoWrite, TaskUpdate).
 * Single source of truth so the ✓/→/○ glyphs and their colors don't drift
 * across renderers. Green aligns with StatusIndicator's success token.
 */
export function TaskStatusIcon({ status }: { status?: string }) {
  if (status === 'completed') return <span className="text-green-600 dark:text-green-400">✓</span>
  if (status === 'in_progress') return <span className="text-blue-500">→</span>
  return <span className="text-muted-foreground">○</span>
}
