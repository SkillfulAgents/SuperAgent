import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
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

/**
 * Chevron that slides in from zero width on row hover/focus — the "this row
 * opens something" affordance shared by every navigable list row (agent home
 * connections + triggers, settings connections, per-agent access list). Put it
 * last in the row's `right` slot. Decorative only: the row itself carries the
 * accessible name.
 */
export function RowHoverChevron({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex justify-center overflow-hidden w-0 opacity-0 transition-all duration-200 ease-out',
        'group-hover:w-4 group-hover:opacity-100 group-focus-visible:w-4 group-focus-visible:opacity-100',
        className,
      )}
    >
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </span>
  )
}

interface IntegrationRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  iconSlug?: string
  iconFallback?: IntegrationIconFallback
  /**
   * Custom icon node rendered inside the muted square instead of ServiceIcon;
   * pass `null` to omit the icon square entirely.
   */
  icon?: ReactNode | null
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
  /** Muted (e.g. a deleted trigger); `disabled` also dims but blocks activation. */
  muted?: boolean
}

/**
 * Standard row used inside <IntegrationList>. 7x7 rounded-md bg-muted icon,
 * text-xs name, text-[11px] muted subtitle, optional right-hand slot (Switch,
 * badge, spinner, etc.).
 *
 * When `onActivate` is provided the row behaves as a button via role/tabIndex
 * rather than a native <button>: the `right` slot often contains interactive
 * children (menu trigger, Switch) and nested <button> elements are invalid.
 *
 * Forwards its ref and any extra DOM props so it can be the `asChild` target
 * of a Radix trigger (e.g. `<ContextMenuTrigger asChild>` for a right-click
 * menu). Handlers the trigger injects run first; a click it `preventDefault`s
 * (the trailing click after a touch long-press) does not activate the row.
 */
export const IntegrationRow = forwardRef<HTMLDivElement, IntegrationRowProps>(function IntegrationRow({
  iconSlug,
  iconFallback,
  icon,
  name,
  nameBadge,
  subtitle,
  right,
  onActivate,
  disabled,
  ariaLabel,
  boxed,
  viewTransitionName,
  muted,
  className,
  style,
  onClick,
  onKeyDown,
  ...rest
}, ref) {
  const interactive = !!onActivate && !disabled
  return (
    <div
      ref={ref}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      {...rest}
      style={viewTransitionName ? ({ ...style, viewTransitionName } as CSSProperties) : style}
      className={cn(
        'group relative py-3 px-4 transition-colors',
        boxed && 'rounded-lg border bg-background',
        interactive && 'hover:bg-muted/50 cursor-pointer',
        (disabled || muted) && 'opacity-50',
        className,
      )}
      onClick={(e) => {
        onClick?.(e)
        if (!interactive || e.defaultPrevented) return
        onActivate?.()
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (!interactive || e.defaultPrevented) return
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onActivate?.()
        }
      }}
    >
      <div className="flex items-center gap-3">
        {icon !== null && (
          <div className="h-7 w-7 rounded-md bg-muted dark:bg-zinc-200 flex items-center justify-center shrink-0">
            {icon ?? (
              <ServiceIcon
                slug={iconSlug}
                fallback={iconFallback ?? 'blocks'}
                className="h-4 w-4 text-muted-foreground/60"
              />
            )}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-medium truncate">{name}</span>
            {/* text-2xs/leading-none pins the badge slot's line-height so a badge
                can't inflate the name row (else it inherits the 16px/1.5 base). */}
            {nameBadge && <span className="shrink-0 text-2xs leading-none">{nameBadge}</span>}
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
})
