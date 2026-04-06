import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { RequestTitleChip } from './request-title-chip'
import { RequestError } from './request-error'
import { usePagination } from './pending-request-stack'

export type RequestTheme = 'blue' | 'orange'

export const THEME_CLASSES: Record<RequestTheme, { chip: string; waitBadge: string }> = {
  blue: {
    chip: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    waitBadge: 'text-blue-600 dark:text-blue-400',
  },
  orange: {
    chip: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
    waitBadge: 'text-orange-600 dark:text-orange-400',
  },
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
  title: string
  icon: ReactNode
  theme: RequestTheme

  completed?: CompletedConfig | null
  readOnly?: ReadOnlyConfig | false

  waitingText?: string
  headerRight?: ReactNode
  children: ReactNode
  error?: string | null

  'data-testid'?: string
  'data-status'?: string
  'data-secret-name'?: string
}

export function RequestItemShell({
  title,
  icon,
  theme,
  completed,
  readOnly,
  waitingText = 'Waiting for response',
  headerRight,
  children,
  error,
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

  if (readOnly) {
    const roConfig = typeof readOnly === 'object' ? readOnly : {}
    return (
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm" {...dataAttrs}>
        <div className="flex items-start gap-3 p-4">
          <div className="flex-1 min-w-0">
            <RequestTitleChip className={themeClasses.chip} icon={icon}>
              {title}
            </RequestTitleChip>
            {roConfig.description}
            {roConfig.extraContent}
          </div>
          <span className={cn('text-xs shrink-0', themeClasses.waitBadge)}>
            {waitingText}
          </span>
        </div>
      </div>
    )
  }

  const paginationControls = pagination && pagination.count > 1 ? (
    <div
      className="inline-flex items-center gap-0.5 px-0.5 py-0.5 text-foreground"
      data-testid="pending-request-pagination"
    >
      <button
        type="button"
        onClick={pagination.goPrev}
        disabled={pagination.currentIndex === 0}
        data-testid="pending-request-prev-btn"
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
        data-testid="pending-request-next-btn"
        className={cn(
          'inline-flex h-5 w-5 items-center justify-center rounded transition-colors',
          pagination.currentIndex === pagination.count - 1 ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted'
        )}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  ) : null

  return (
    <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm" {...dataAttrs}>
      <div className="p-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <RequestTitleChip className={themeClasses.chip} icon={icon}>
              {title}
            </RequestTitleChip>
            {paginationControls ?? headerRight}
          </div>
          {children}
          <RequestError message={error ?? null} />
        </div>
      </div>
    </div>
  )
}
