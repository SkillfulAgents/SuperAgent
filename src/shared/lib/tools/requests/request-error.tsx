import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, Info, type LucideIcon } from 'lucide-react'

import { cn } from '@shared/lib/utils/cn'

export type RequestErrorSeverity = 'error' | 'warning'

interface RequestErrorProps {
  message: ReactNode
  className?: string
  'data-testid'?: string
  /** Leading label before the message. Name the source when it is not this app. */
  label?: string | null
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
  severity?: RequestErrorSeverity
  icon?: LucideIcon
}

const VARIANT_CLASSES: Record<NonNullable<RequestErrorProps['variant']>, string> = {
  default: '',
  compact: 'mt-0 px-2',
}

const SEVERITY_CLASSES: Record<RequestErrorSeverity, {
  banner: string
  details: string
  hint: string
}> = {
  error: {
    banner: 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300',
    details: 'text-red-700/85 group-hover:text-red-700 dark:text-red-300/85 dark:group-hover:text-red-300',
    hint: 'text-red-700/75 dark:text-red-300/75',
  },
  warning: {
    banner: 'bg-orange-50 text-orange-800 dark:bg-orange-950/30 dark:text-orange-300',
    details: 'text-orange-800/85 group-hover:text-orange-800 dark:text-orange-300/85 dark:group-hover:text-orange-300',
    hint: 'text-orange-800/75 dark:text-orange-300/75',
  },
}

export function RequestError({
  message,
  className,
  variant = 'default',
  'data-testid': testId,
  label = 'Error',
  hint,
  severity = 'error',
  icon: Icon = Info,
}: RequestErrorProps) {
  const [showDetails, setShowDetails] = useState(false)

  if (!message) return null

  const tones = SEVERITY_CLASSES[severity]
  const expandable = Boolean(hint)

  const toggle = () => setShowDetails((shown) => !shown)

  const handleClick = () => {
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
      data-severity={severity}
      {...(expandable ? {
        role: 'button',
        tabIndex: 0,
        'aria-expanded': showDetails,
        onClick: handleClick,
        onKeyDown: handleKeyDown,
      } : {})}
      className={cn(
        'mt-4 rounded-md px-3 py-2 text-xs',
        tones.banner,
        'select-text [&_*]:select-text',
        expandable && 'group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          {label ? <>{label}: </> : null}
          {message}
        </span>
        {expandable && (
          <span className={cn('inline-flex shrink-0 items-center gap-1 font-medium transition-colors', tones.details)}>
            More details
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', showDetails && 'rotate-180')}
              aria-hidden="true"
            />
          </span>
        )}
      </div>
      {hint && showDetails && (
        <p className={cn('mt-1', tones.hint)}>{hint}</p>
      )}
    </div>
  )
}
