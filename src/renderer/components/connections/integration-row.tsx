import type { ReactNode } from 'react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'

type IntegrationIconFallback = 'oauth' | 'mcp' | 'blocks'

interface IntegrationListProps {
  children: ReactNode
  className?: string
}

/**
 * Shared list container for integration/connection rows — rounded card with
 * divided rows. Used by the Integrations page and the directory dialog so both
 * have the same visual treatment.
 */
export function IntegrationList({ children, className }: IntegrationListProps) {
  return (
    <div
      className={
        'rounded-xl border bg-background divide-y divide-border/50 overflow-hidden ' +
        (className ?? '')
      }
    >
      {children}
    </div>
  )
}

interface IntegrationRowProps {
  iconSlug?: string
  iconFallback: IntegrationIconFallback
  name: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  onActivate?: () => void
  disabled?: boolean
  ariaLabel?: string
}

/**
 * Standard row used inside <IntegrationList>. Matches the home-connections
 * styling: 7x7 rounded-md bg-muted icon, text-xs name, text-[11px] muted
 * subtitle, optional right-hand slot (Switch, badge, spinner, etc.).
 */
export function IntegrationRow({
  iconSlug,
  iconFallback,
  name,
  subtitle,
  right,
  onActivate,
  disabled,
  ariaLabel,
}: IntegrationRowProps) {
  const interactive = !!onActivate && !disabled
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={
        'group relative py-3 px-4 transition-colors ' +
        (interactive ? 'hover:bg-muted/50 cursor-pointer ' : '') +
        (disabled ? 'opacity-50 ' : '')
      }
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
          <div className="text-xs font-medium truncate">{name}</div>
          {subtitle && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
              {subtitle}
            </div>
          )}
        </div>
        {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
      </div>
    </div>
  )
}
