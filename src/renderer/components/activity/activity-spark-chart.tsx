import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  DEFAULT_CRON_ACTIVITY_SLOTS,
  type CronActivityPoint,
  type DailyActivityPoint,
} from '@shared/lib/types/activity'
import { cn } from '@shared/lib/utils/cn'

/**
 * The viewBox matches the rendered footprint exactly, so one unit is one CSS
 * pixel and nothing is letterboxed by preserveAspectRatio. Width is whatever
 * the default grid needs at BAR_WIDTH/BAR_GAP (14 * 4 + 13 * 1.54 = 76) rather
 * than a round container size, so the bars keep their shipped dimensions
 * instead of being stretched to fill a wider box. See CHART_SIZE.
 */
const WIDTH = 76
const HEIGHT = 20

/**
 * One bar width for every spark chart: a cron strip and a daily chart sit side
 * by side in the same row, so bars that differed in width read as two different
 * components. 4x18 matches the shipped cron strip; the gap absorbs any
 * difference in slot count. Bars only shrink below BAR_WIDTH when even MIN_GAP
 * would not fit — a cron history longer than the default grid.
 */
const BAR_WIDTH = 4
const MIN_GAP = 1

function slotGeometry(count: number) {
  const width = count > 0
    ? Math.min(BAR_WIDTH, Math.max(1, (WIDTH - MIN_GAP * (count - 1)) / count))
    : BAR_WIDTH
  const gap = count > 1 ? (WIDTH - width * count) / (count - 1) : 0
  return { width, gap, radius: Math.min(2, width / 2), x: (index: number) => index * (width + gap) }
}

/** The one footprint for every spark chart, skeleton included. */
const CHART_SIZE = 'h-5 w-[76px]'

/**
 * Both charts sit in the same rows at the same size, so they share one visual
 * language: every slot draws a faint full-height track covering the whole
 * window, and status/volume fills it from the bottom. The track is what makes
 * an empty or short history legible — you can see how much window is unused.
 */
const TRACK_INSET = 1
const TRACK_HEIGHT = HEIGHT - TRACK_INSET * 2
const TRACK_BASELINE = HEIGHT - TRACK_INSET
const TRACK_CLASS = 'fill-muted-foreground/10'

/** Keeps a lone call in a tall series from rendering as a sub-pixel sliver. */
const MIN_SEGMENT = 1.5

interface SparkTooltipRow {
  /** Tailwind background class for the legend swatch. */
  swatch: string
  /** Leading figure; omitted for rows that are just a state (cron slots). */
  count?: number
  label: string
}

interface SparkTooltipContent {
  title: string
  rows: SparkTooltipRow[]
}

interface SparkChartFrameProps {
  accessibleLabel: string
  className?: string
  /** One entry per column, in column order; null suppresses the tooltip. */
  columns: Array<SparkTooltipContent | null>
  geometry: ReturnType<typeof slotGeometry>
  children: ReactNode
}

/** Viewport-space box of the hovered chart, from getBoundingClientRect. */
interface SparkAnchor {
  top: number
  right: number
  bottom: number
}

/** Gap between the card and the chart edge it hangs off. */
const TOOLTIP_OFFSET = 6
/**
 * Room the card needs above the chart before it flips underneath: ~60px tall
 * at two rows, plus the offset, plus a little slack.
 */
const TOOLTIP_FLIP_THRESHOLD = 72

function SparkTooltipCard({ title, rows, anchor }: SparkTooltipContent & { anchor: SparkAnchor }) {
  // Above the chart unless that would run off the top of the viewport (a chart
  // in the first row of a page or a scroll container), then below it.
  const above = anchor.top >= TOOLTIP_FLIP_THRESHOLD
  const style = above
    ? { left: anchor.right, top: anchor.top - TOOLTIP_OFFSET, transform: 'translate(-100%, -100%)' }
    : { left: anchor.right, top: anchor.bottom + TOOLTIP_OFFSET, transform: 'translateX(-100%)' }
  return createPortal(
    <span
      role="tooltip"
      data-testid="spark-tooltip"
      // Portalled to <body> and placed in viewport space: the charts live in
      // overflow-hidden containers (the home carousel, the settings connections
      // list) that would clip a card positioned within the row.
      // Anchored to the chart, not the hovered column: the card is wider than
      // the whole 76px strip, so pointing it at a 4px bar would only push it
      // past the row's edge — the title says which column it is. Right-aligned
      // because these charts sit at the right of every row they appear in, so
      // the card can only ever grow inwards.
      className="pointer-events-none fixed z-50 rounded-lg border bg-popover px-2.5 py-2 text-popover-foreground shadow-lg"
      style={style}
    >
      <span className="mb-1.5 block whitespace-nowrap text-xs font-medium">{title}</span>
      <span className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <span aria-hidden="true" className={cn('h-2.5 w-2.5 shrink-0 rounded-[3px]', row.swatch)} />
            <span className="whitespace-nowrap text-xs">
              {row.count === undefined ? null : (
                <span className="tabular-nums">{row.count} </span>
              )}
              <span className="text-muted-foreground">{row.label}</span>
            </span>
          </Fragment>
        ))}
      </span>
    </span>,
    document.body,
  )
}

/**
 * Shared hover layer for both spark charts.
 *
 * Bars are 4px wide, so the hit target is the whole column band (bar + gap),
 * full height — otherwise hovering a short bar or an empty slot does nothing.
 * The tooltip is a plain positioned element rather than the Radix one: a single
 * row can hold several charts and the home page many more, and one Radix
 * Tooltip (plus Provider) per column would mean hundreds of components for
 * what is a label following the cursor across at most 14 bands.
 */
function SparkChartFrame({
  accessibleLabel,
  className,
  columns,
  geometry,
  children,
}: SparkChartFrameProps) {
  const [hover, setHover] = useState<{ index: number; anchor: SparkAnchor } | null>(null)
  const { width, gap, x } = geometry
  const active = hover ? columns[hover.index] : null

  // The anchor is measured on enter, so a scroll while hovering would leave
  // the card floating where the chart used to be. Dismiss instead; the next
  // band the cursor crosses re-measures.
  useEffect(() => {
    if (!hover) return
    const dismiss = () => setHover(null)
    window.addEventListener('scroll', dismiss, { capture: true, passive: true })
    return () => window.removeEventListener('scroll', dismiss, { capture: true })
  }, [hover])

  return (
    // `flex`, not `inline-flex`: an inline-level wrapper sits in the parent's
    // line box, which adds descender space beneath it and pushes the chart off
    // centre against neighbouring text.
    <span className={cn('flex', className)}>
      {active && hover ? <SparkTooltipCard {...active} anchor={hover.anchor} /> : null}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={accessibleLabel}
        className={cn(CHART_SIZE, 'overflow-visible')}
        onMouseLeave={() => setHover(null)}
      >
        {children}
        {columns.map((_, index) => {
          // Bands meet halfway across each gap and stop at the chart edges, so
          // no two overlap and none reaches past the viewBox.
          const left = Math.max(0, x(index) - gap / 2)
          const right = Math.min(WIDTH, x(index) + width + gap / 2)
          return (
            <rect
              key={`hit-${index}`}
              data-testid="spark-hit"
              aria-hidden="true"
              x={left}
              y={0}
              width={right - left}
              height={HEIGHT}
              fill="transparent"
              onMouseEnter={(event) => {
                const box = event.currentTarget.ownerSVGElement!.getBoundingClientRect()
                setHover({ index, anchor: { top: box.top, right: box.right, bottom: box.bottom } })
              }}
            />
          )
        })}
      </svg>
    </span>
  )
}

/**
 * Same footprint as the charts so rows don't shift when the activity query
 * resolves. Rendered while the query is pending; an errored query renders
 * nothing (rows stay usable, width collapses once, no retry churn).
 */
export function ActivitySparkChartSkeleton({ className }: { className?: string }) {
  return (
    <div
      data-testid="activity-chart-skeleton"
      aria-hidden="true"
      className={cn(CHART_SIZE, 'rounded-sm bg-muted/40 animate-pulse', className)}
    />
  )
}

interface ActivitySparkChartProps {
  label: string
  data: DailyActivityPoint[]
  className?: string
}

export function dayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed)
}

export function plural(value: number, singular: string, multiple = `${singular}s`): string {
  return value === 1 ? singular : multiple
}

export function summarizeDailyActivity(data: DailyActivityPoint[]) {
  const succeeded = data.reduce((sum, point) => sum + point.succeeded, 0)
  const failed = data.reduce((sum, point) => sum + point.failed, 0)
  return { succeeded, failed, total: succeeded + failed }
}

export function ActivitySparkChart({ label, data, className }: ActivitySparkChartProps) {
  const { succeeded, failed, total } = summarizeDailyActivity(data)
  const max = Math.max(1, ...data.map((point) => point.succeeded + point.failed))
  const geometry = slotGeometry(data.length)
  const { width: barWidth, radius, x: barX } = geometry
  const accessibleLabel = total === 0
    ? `${label}: no calls over the last ${data.length} ${plural(data.length, 'day')}.`
    : `${label}: ${total} ${plural(total, 'call')} over ${data.length} ${plural(data.length, 'day')}, ${succeeded} succeeded and ${failed} failed.`
  const columns = data.map((point) => ({
    title: dayLabel(point.date),
    rows: [
      { swatch: 'bg-emerald-500', count: point.succeeded, label: 'Succeeded' },
      { swatch: 'bg-red-500', count: point.failed, label: 'Failed' },
    ],
  }))

  return (
    <SparkChartFrame
      accessibleLabel={accessibleLabel}
      className={className}
      columns={columns}
      geometry={geometry}
    >
      {data.map((point, index) => {
        const x = barX(index)
        const successHeight = point.succeeded > 0
          ? Math.max(MIN_SEGMENT, (point.succeeded / max) * TRACK_HEIGHT)
          : 0
        const failureHeight = point.failed > 0
          ? Math.max(MIN_SEGMENT, (point.failed / max) * TRACK_HEIGHT)
          : 0
        return (
          <g key={point.date}>
            <rect
              data-testid="activity-day-track"
              aria-hidden="true"
              x={x}
              y={TRACK_INSET}
              width={barWidth}
              height={TRACK_HEIGHT}
              rx={radius}
              className={TRACK_CLASS}
            />
            <rect
              data-testid="activity-success-bar"
              x={x}
              y={TRACK_BASELINE - successHeight}
              width={barWidth}
              height={successHeight}
              rx={radius}
              className="fill-emerald-500"
            />
            <rect
              data-testid="activity-failure-bar"
              x={x}
              y={TRACK_BASELINE - successHeight - failureHeight}
              width={barWidth}
              height={failureHeight}
              rx={radius}
              className="fill-red-500"
            />
          </g>
        )
      })}
    </SparkChartFrame>
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
  skipped: 'fill-muted-foreground/40',
  failed: 'fill-red-500',
}

/** Background (not fill) twins of CRON_COLORS, for the tooltip legend swatch. */
const CRON_SWATCH: Record<CronActivityPoint['status'], string> = {
  succeeded: 'bg-emerald-500',
  running: 'bg-emerald-500',
  skipped: 'bg-muted-foreground/40',
  failed: 'bg-red-500',
}

const CRON_LABEL: Record<CronActivityPoint['status'], string> = {
  succeeded: 'Succeeded',
  running: 'Running',
  skipped: 'Skipped',
  failed: 'Failed',
}

/**
 * A skipped run reads as a centred marker on an otherwise empty track rather
 * than a full-height grey bar: nothing ran, so nothing should fill the slot.
 */
const CRON_SKIPPED_HEIGHT = 3

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
  const gridSlots = Math.max(DEFAULT_CRON_ACTIVITY_SLOTS, data.length)
  const geometry = slotGeometry(gridSlots)
  const { width, radius, x: slotX } = geometry
  const firstGridSlot = gridSlots - data.length
  const runningSummary = running > 0 ? `${running} running, ` : ''
  const accessibleLabel = data.length === 0
    ? `${label}: no mature planned runs yet.`
    : `${label}: ${data.length} planned ${plural(data.length, 'run')}, ${succeeded} ran, ${runningSummary}${skipped} skipped, and ${failed} failed.`
  // Empty leading slots predate the task, so they get no tooltip.
  const columns = Array.from({ length: gridSlots }, (_, index) => {
    const point = data[index - firstGridSlot]
    if (!point) return null
    return {
      title: cronTimeLabel(point.scheduledAt),
      rows: [{ swatch: CRON_SWATCH[point.status], label: CRON_LABEL[point.status] }],
    }
  })

  return (
    <SparkChartFrame
      accessibleLabel={accessibleLabel}
      className={className}
      columns={columns}
      geometry={geometry}
    >
      {Array.from({ length: gridSlots }, (_, index) => (
        <rect
          key={`track-${index}`}
          data-testid={index < firstGridSlot ? 'cron-slot-no-history' : 'cron-slot-track'}
          aria-hidden="true"
          x={slotX(index)}
          y={TRACK_INSET}
          width={width}
          height={TRACK_HEIGHT}
          rx={radius}
          className={TRACK_CLASS}
        />
      ))}
      {data.map((point, index) => {
        const isSkipped = point.status === 'skipped'
        return (
          <rect
            key={`${point.scheduledAt}-${index}`}
            data-testid={`cron-slot-${point.status}`}
            data-status={point.status}
            x={slotX(firstGridSlot + index)}
            y={isSkipped ? (HEIGHT - CRON_SKIPPED_HEIGHT) / 2 : TRACK_INSET}
            width={width}
            height={isSkipped ? CRON_SKIPPED_HEIGHT : TRACK_HEIGHT}
            rx={isSkipped ? Math.min(radius, CRON_SKIPPED_HEIGHT / 2) : radius}
            className={CRON_COLORS[point.status]}
          />
        )
      })}
    </SparkChartFrame>
  )
}
