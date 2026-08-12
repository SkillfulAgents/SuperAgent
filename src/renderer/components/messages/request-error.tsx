import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, Info } from 'lucide-react'

import { cn } from '@shared/lib/utils/cn'

interface RequestErrorProps {
  message: string | null
  className?: string
  'data-testid'?: string
  /** Leading label before the message. Name the source when it is not this app. */
  label?: string
  /**
   * Guidance about the error, folded behind a "More details" toggle inside the
   * banner. Kept out of the way by default so the failure itself is the whole
   * of the first read. Without one the banner is inert, as it has always been.
   */
  hint?: ReactNode
  /**
   * Visual treatment. `default` is the standalone red banner; `compact` is the
   * tight, borderless destructive style used inline at the bottom of settings forms.
   */
  variant?: 'default' | 'compact'
}

const VARIANT_CLASSES: Record<NonNullable<RequestErrorProps['variant']>, string> = {
  default: '',
  // Tight inline form errors keep the same soft red palette as the default
  // banner — only the spacing differs.
  compact: 'mt-0 px-2',
}

export function RequestError({
  message,
  className,
  variant = 'default',
  'data-testid': testId,
  label = 'Error',
  hint,
}: RequestErrorProps) {
  const [showDetails, setShowDetails] = useState(false)

  if (!message) return null

  const toggle = () => setShowDetails((shown) => !shown)

  const handleClick = () => {
    // A click that ends a drag is someone copying the error, not asking for
    // details — leave the selection alone and don't toggle under them.
    if (window.getSelection()?.toString()) return
    toggle()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggle()
  }

  return (
    <div
      data-testid={testId}
      // The whole banner is the target, so the affordance below is a span, not
      // a nested button. role/tabIndex rather than a real <button> because the
      // message has to stay selectable — inside a button, dragging to copy it
      // reads as a click instead.
      {...(hint ? {
        role: 'button',
        tabIndex: 0,
        'aria-expanded': showDetails,
        onClick: handleClick,
        onKeyDown: handleKeyDown,
      } : {})}
      className={cn(
        'mt-4 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300',
        hint && 'group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {/* mt-px nudges the 14px glyph onto the 16px line box's optical center. */}
        <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{label}: {message}</span>
        {hint && (
          // Matches the billing banners' "Go to billing" affordance. Hover is
          // driven off the container's `group` rather than the span's own
          // :hover — the whole banner is the target, so the label has to
          // respond wherever the pointer is.
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-red-700/85 transition-colors group-hover:text-red-700 dark:text-red-300/85 dark:group-hover:text-red-300">
            More details
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', showDetails && 'rotate-180')}
              aria-hidden="true"
            />
          </span>
        )}
      </div>
      {/* Softened rather than muted-foreground: guidance belongs to the error,
          so it stays inside the banner and in its palette, just under the
          message in weight. */}
      {hint && showDetails && (
        <p className="mt-1 text-red-700/75 dark:text-red-300/75">{hint}</p>
      )}
    </div>
  )
}
