import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { RequestItemErrorContext } from './request-item-actions'
import { usePagination } from './pending-request-stack'
import { StopSessionButton } from './stop-session-button'

export type RequestTheme = 'blue' | 'orange'

export const THEME_CLASSES: Record<RequestTheme, { waitBadge: string }> = {
  blue: { waitBadge: 'text-blue-600 dark:text-blue-400' },
  orange: { waitBadge: 'text-orange-600 dark:text-orange-400' },
}

interface CompletedConfig {
  icon: ReactNode
  label: ReactNode
  statusLabel: string
  isSuccess: boolean
}

interface ReadOnlyConfig {
  description?: ReactNode
  extraContent?: ReactNode
}

interface RequestItemShellProps {
  title: ReactNode
  /** Optional helper text rendered directly under the title with consistent
   *  typography and spacing (text-xs muted, mt-1). Omit to skip. */
  subtitle?: ReactNode
  icon?: ReactNode
  theme: RequestTheme

  completed?: CompletedConfig | null
  readOnly?: ReadOnlyConfig | false

  waitingText?: string
  headerRight?: ReactNode
  children: ReactNode
  error?: string | null

  /** When provided alongside `agentSlug`, shows an X button next to the
   *  header pagination/right area that interrupts the session. */
  sessionId?: string
  agentSlug?: string

  'data-testid'?: string
  'data-status'?: string
  'data-secret-name'?: string
}

export function RequestItemShell({
  title,
  subtitle,
  icon,
  theme,
  completed,
  readOnly,
  waitingText = 'Waiting for response',
  headerRight,
  children,
  error,
  sessionId,
  agentSlug,
  ...dataAttrs
}: RequestItemShellProps) {
  const themeClasses = THEME_CLASSES[theme]
  const pagination = usePagination()

  if (completed) {
    return (
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm" {...dataAttrs}>
        <div className="flex items-center gap-2 p-4">
          {completed.icon}
          <span className="text-sm">{completed.label}</span>
          <span className={cn('ml-auto text-xs', completed.isSuccess ? 'text-green-600' : 'text-red-600')}>
            {completed.statusLabel}
          </span>
        </div>
      </div>
    )
  }

  const titleNode = (
    <div className="flex flex-1 min-w-0 items-start gap-2">
      {icon && (
        <span className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
          {icon}
        </span>
      )}
      <div className="flex-1 min-w-0 text-sm font-medium leading-5 text-foreground whitespace-pre-line">
        {title}
      </div>
    </div>
  )

  const subtitleNode = subtitle ? (
    <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
  ) : null

  if (readOnly) {
    const roConfig = typeof readOnly === 'object' ? readOnly : {}
    return (
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm" {...dataAttrs}>
        <div className="flex items-start gap-3 p-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3">
              {titleNode}
              <span className={cn('text-xs shrink-0', themeClasses.waitBadge)}>
                {waitingText}
              </span>
            </div>
            {subtitleNode}
            {roConfig.description}
            {roConfig.extraContent}
          </div>
        </div>
      </div>
    )
  }

  const paginationControls = pagination && pagination.count > 1 ? (
    <div
      className="inline-flex items-center gap-0.5 px-0.5 text-foreground"
      data-testid="request-stack-pagination"
      data-current-index={pagination.currentIndex}
      data-count={pagination.count}
    >
      <button
        type="button"
        onClick={pagination.goPrev}
        disabled={pagination.currentIndex === 0}
        data-testid="request-stack-prev"
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded transition-colors',
          pagination.currentIndex === 0 ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted'
        )}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="min-w-10 text-center text-xs font-medium">
        {pagination.currentIndex + 1} of {pagination.count}
      </span>
      <button
        type="button"
        onClick={pagination.goNext}
        disabled={pagination.currentIndex === pagination.count - 1}
        data-testid="request-stack-next"
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded transition-colors',
          pagination.currentIndex === pagination.count - 1 ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted'
        )}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  ) : null

  const headerRightContent = paginationControls ?? headerRight
  const showStopButton = !!(sessionId && agentSlug)

  return (
    <div
      className="max-h-[50vh] overflow-y-auto border rounded-[12px] bg-muted/30 shadow-md text-sm"
      {...dataAttrs}
    >
      <div className="p-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            {titleNode}
            {(headerRightContent || showStopButton) && (
              <div className="flex items-center shrink-0">
                {headerRightContent}
                {showStopButton && (
                  <>
                    {headerRightContent && (
                      <div className="ml-[5px] mr-[9px] h-4 w-px bg-border" aria-hidden />
                    )}
                    <StopSessionButton sessionId={sessionId!} agentSlug={agentSlug!} />
                  </>
                )}
              </div>
            )}
          </div>
          {subtitleNode}
          <RequestItemErrorContext.Provider value={error ?? null}>
            {children}
          </RequestItemErrorContext.Provider>
        </div>
      </div>
    </div>
  )
}
