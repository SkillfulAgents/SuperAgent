import { cn } from '@shared/lib/utils'

interface ProgressProps {
  /** Fill percentage, 0–100 (clamped). */
  percent: number
  /**
   * Color thresholds on the REMAINING percent: at/below `critical` → red,
   * at/below `warning` → amber, otherwise primary. Mirrors the platform web
   * app's seat-quota bar. Omit for a plain primary bar (an upload bar must
   * not read as "failing" at 3%).
   */
  thresholds?: { warning: number; critical: number }
  className?: string
}

export function Progress({ percent, thresholds, className }: ProgressProps) {
  const pct = Math.max(0, Math.min(100, percent))
  const color = !thresholds
    ? 'bg-primary'
    : pct <= thresholds.critical
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
