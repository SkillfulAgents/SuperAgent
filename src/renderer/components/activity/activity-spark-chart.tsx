import {
  DEFAULT_CRON_ACTIVITY_SLOTS,
  type CronActivityPoint,
  type DailyActivityPoint,
} from '@shared/lib/types/activity'
import { cn } from '@shared/lib/utils/cn'

const WIDTH = 96
const HEIGHT = 26
const BAR_GAP = 1.5

/**
 * Same footprint as the charts (h-7 w-24) so rows don't shift when the
 * activity query resolves. Rendered while the query is pending; an errored
 * query renders nothing (rows stay usable, width collapses once, no retry churn).
 */
export function ActivitySparkChartSkeleton({ className }: { className?: string }) {
  return (
    <div
      data-testid="activity-chart-skeleton"
      aria-hidden="true"
      className={cn('h-7 w-24 rounded-sm bg-muted/40 animate-pulse', className)}
    />
  )
}

interface ActivitySparkChartProps {
  label: string
  data: DailyActivityPoint[]
  className?: string
}

function dayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed)
}

function plural(value: number, singular: string, multiple = `${singular}s`): string {
  return value === 1 ? singular : multiple
}

export function ActivitySparkChart({ label, data, className }: ActivitySparkChartProps) {
  const succeeded = data.reduce((sum, point) => sum + point.succeeded, 0)
  const failed = data.reduce((sum, point) => sum + point.failed, 0)
  const total = succeeded + failed
  const max = Math.max(1, ...data.map((point) => point.succeeded + point.failed))
  const barWidth = data.length > 0
    ? Math.max(1, (WIDTH - BAR_GAP * (data.length - 1)) / data.length)
    : WIDTH
  const accessibleLabel = total === 0
    ? `${label}: no calls over the last ${data.length} ${plural(data.length, 'day')}.`
    : `${label}: ${total} ${plural(total, 'call')} over ${data.length} ${plural(data.length, 'day')}, ${succeeded} succeeded and ${failed} failed.`

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={accessibleLabel}
      className={cn('h-7 w-24 overflow-visible', className)}
    >
      {data.map((point, index) => {
        const x = index * (barWidth + BAR_GAP)
        const successHeight = (point.succeeded / max) * (HEIGHT - 2)
        const failureHeight = (point.failed / max) * (HEIGHT - 2)
        const zeroHeight = point.succeeded === 0 && point.failed === 0 ? 1 : 0
        return (
          <g key={point.date}>
            <title>{dayLabel(point.date)}: {point.succeeded} succeeded, {point.failed} failed</title>
            <rect
              data-testid="activity-success-bar"
              x={x}
              y={HEIGHT - successHeight - zeroHeight}
              width={barWidth}
              height={successHeight + zeroHeight}
              rx={Math.min(1.5, barWidth / 2)}
              className={point.succeeded === 0 ? 'fill-muted' : 'fill-emerald-500'}
            />
            <rect
              data-testid="activity-failure-bar"
              x={x}
              y={HEIGHT - successHeight - failureHeight}
              width={barWidth}
              height={failureHeight}
              rx={Math.min(1.5, barWidth / 2)}
              className="fill-red-500"
            />
          </g>
        )
      })}
    </svg>
  )
}

interface CronSparkChartProps {
  label: string
  data: CronActivityPoint[]
  className?: string
}

const CRON_COLORS: Record<CronActivityPoint['status'], string> = {
  succeeded: 'fill-emerald-500',
  running: 'fill-emerald-500 animate-pulse',
  skipped: 'fill-muted-foreground/25',
  failed: 'fill-red-500',
}

function cronTimeLabel(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(value))
}

export function CronSparkChart({ label, data, className }: CronSparkChartProps) {
  const succeeded = data.filter((point) => point.status === 'succeeded').length
  const running = data.filter((point) => point.status === 'running').length
  const skipped = data.filter((point) => point.status === 'skipped').length
  const failed = data.filter((point) => point.status === 'failed').length
  const width = 4
  const placeholderStrokeWidth = 1
  const placeholderInset = placeholderStrokeWidth / 2
  const gridSlots = Math.max(DEFAULT_CRON_ACTIVITY_SLOTS, data.length)
  const gap = gridSlots > 1 ? Math.max(1, (WIDTH - width * gridSlots) / (gridSlots - 1)) : 0
  const firstGridSlot = gridSlots - data.length
  const runningSummary = running > 0 ? `${running} running, ` : ''
  const accessibleLabel = data.length === 0
    ? `${label}: no mature planned runs yet.`
    : `${label}: ${data.length} planned ${plural(data.length, 'run')}, ${succeeded} ran, ${runningSummary}${skipped} skipped, and ${failed} failed.`

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={accessibleLabel}
      className={cn('h-7 w-24 overflow-visible', className)}
    >
      {Array.from({ length: firstGridSlot }, (_, index) => (
        <rect
          key={`no-history-${index}`}
          data-testid="cron-slot-no-history"
          aria-hidden="true"
          x={index * (width + gap) + placeholderInset}
          y={4 + placeholderInset}
          width={width - placeholderStrokeWidth}
          height={18 - placeholderStrokeWidth}
          rx={2 - placeholderInset}
          strokeWidth={placeholderStrokeWidth}
          className="fill-none stroke-muted-foreground/20"
        />
      ))}
      {data.map((point, index) => (
        <rect
          key={`${point.scheduledAt}-${index}`}
          data-testid={`cron-slot-${point.status}`}
          data-status={point.status}
          x={(firstGridSlot + index) * (width + gap)}
          y={4}
          width={width}
          height={18}
          rx={2}
          className={CRON_COLORS[point.status]}
        >
          <title>{cronTimeLabel(point.scheduledAt)}: {point.status}</title>
        </rect>
      ))}
    </svg>
  )
}
