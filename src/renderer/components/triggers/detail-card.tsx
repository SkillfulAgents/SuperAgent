import type { ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'

interface DetailCardProps {
  label?: string
  headerActions?: ReactNode
  footer?: ReactNode
  className?: string
  children: ReactNode
}

export function DetailCard({ label, headerActions, footer, className, children }: DetailCardProps) {
  const hasHeader = label !== undefined || headerActions !== undefined

  return (
    <div className={cn('rounded-xl border bg-background py-4', className)}>
      {hasHeader && (
        <div className="px-4 flex items-center justify-between gap-4">
          {label !== undefined ? (
            <span className="text-sm font-medium text-muted-foreground">{label}</span>
          ) : (
            <span />
          )}
          {headerActions}
        </div>
      )}
      <div className={cn('px-4', hasHeader && 'pt-3')}>
        {children}
      </div>
      {footer && (
        <div className="px-4 pt-6 text-xs text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  )
}
