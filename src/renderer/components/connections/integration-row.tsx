import type { CSSProperties, ReactNode } from 'react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { cn } from '@shared/lib/utils/cn'

type IntegrationIconFallback = 'oauth' | 'mcp' | 'blocks'

interface IntegrationListProps {
  children: ReactNode
  className?: string
  /** `list` = stacked divided rows; `grid` = 2-col grid of bordered cards. */
  variant?: 'list' | 'grid'
}

/**
 * Shared list container for integration/connection rows.
 * - `list` (default): rounded card with divided rows.
 * - `grid`: 2-column grid of standalone bordered tiles.
 */
export function IntegrationList({ children, className, variant = 'list' }: IntegrationListProps) {
  if (variant === 'grid') {
    return (
      <div className={cn('grid grid-cols-2 gap-2 items-start', className)}>
        {children}
      </div>
    )
  }
  return (
    <div className={cn('rounded-xl border bg-background divide-y divide-border/50 overflow-hidden', className)}>
      {children}
    </div>
  )
}

interface IntegrationRowProps {
  iconSlug?: string
  iconFallback: IntegrationIconFallback
  name: ReactNode
  /** Inline badge/chip rendered next to the name on the same row. */
  nameBadge?: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  onActivate?: () => void
  disabled?: boolean
  ariaLabel?: string
  /** When true, renders as a standalone bordered tile (for use in grids). */
  boxed?: boolean
  /**
   * Optional `view-transition-name` applied to the row. When set, the
   * browser's View Transitions API will animate the row's position between
   * re-renders — used to animate rows moving between list sections.
   */
  viewTransitionName?: string
}

/**
 * Standard row used inside <IntegrationList>. 7x7 rounded-md bg-muted icon,
 * text-xs name, text-[11px] muted subtitle, optional right-hand slot (Switch,
 * badge, spinner, etc.).
 *
 * When `onActivate` is provided the row behaves as a button via role/tabIndex
 * rather than a native <button>: the `right` slot often contains interactive
 * children (menu trigger, Switch) and nested <button> elements are invalid.
 */
export function IntegrationRow({
  iconSlug,
  iconFallback,
  name,
  nameBadge,
  subtitle,
  right,
  onActivate,
  disabled,
  ariaLabel,
  boxed,
  viewTransitionName,
}: IntegrationRowProps) {
  const interactive = !!onActivate && !disabled
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      style={viewTransitionName ? ({ viewTransitionName } as CSSProperties) : undefined}
      className={cn(
        'group relative py-3 px-4 transition-colors',
        boxed && 'rounded-lg border bg-background',
        interactive && 'hover:bg-muted/50 cursor-pointer',
        disabled && 'opacity-50',
      )}
      onClick={interactive ? onActivate : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onActivate?.()
              }
            }
          : undefined
      }
    >
      <div className="flex items-center gap-3">
        <div className="h-7 w-7 rounded-md bg-muted flex items-center justify-center shrink-0">
          <ServiceIcon
            slug={iconSlug}
            fallback={iconFallback}
            className="h-4 w-4 text-muted-foreground/60"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium truncate">{name}</span>
            {nameBadge && <span className="shrink-0">{nameBadge}</span>}
          </div>
          {subtitle && (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground mt-0.5">
              {subtitle}
            </div>
          )}
        </div>
        {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
      </div>
    </div>
  )
}
