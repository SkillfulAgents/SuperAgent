import { cn } from '@shared/lib/utils'

/**
 * Colour thresholds on the REMAINING percent, mirroring the platform web app's
 * seat-quota bar. Exported so the low-balance warning fires at exactly the point
 * this bar turns amber — one story between Settings and the session view.
 */
export const PROGRESS_THRESHOLDS = { warning: 20, critical: 5 } as const

interface ProgressProps {
  /** Fill percentage, 0–100 (clamped). */
  percent: number
  /** Override the shared PROGRESS_THRESHOLDS for this bar. */
  thresholds?: { warning: number; critical: number }
  className?: string
}

export function Progress({ percent, thresholds = PROGRESS_THRESHOLDS, className }: ProgressProps) {
  const pct = Math.max(0, Math.min(100, percent))
  const color =
    pct <= thresholds.critical
      ? 'bg-red-500'
      : pct <= thresholds.warning
        ? 'bg-amber-500'
        : 'bg-primary'

  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
    </div>
  )
}
