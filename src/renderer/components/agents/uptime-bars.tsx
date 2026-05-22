import { cn } from '@shared/lib/utils/cn'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'

export type UptimeRunStatus = 'success' | 'awaiting' | 'failed' | 'empty'

export interface UptimeRun {
  status: UptimeRunStatus
  /** Session this run created. Optional — mocked data has no real session. */
  sessionId?: string
  /** When the run started. Used in the hover tooltip. */
  startedAt?: Date
}

const STATUS_CLASSES: Record<UptimeRunStatus, string> = {
  success: 'bg-green-500',
  awaiting: 'bg-orange-500',
  failed: 'bg-red-500',
  empty: 'bg-muted-foreground/25',
}

const STATUS_LABELS: Record<UptimeRunStatus, string> = {
  success: 'Succeeded',
  awaiting: 'Awaiting input',
  failed: 'Failed',
  empty: 'No run',
}

interface UptimeBarsProps {
  runs: UptimeRun[]
  label: string
  /** Called when a non-empty bar is clicked. Empty bars are not clickable. */
  onRunClick?: (run: UptimeRun, index: number) => void
}

function formatRunTime(d: Date | undefined): string {
  if (!d) return ''
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * Compact run-history visual: a row of pill-shaped bars (one per recent run),
 * an "X/Y" success count, and a label. Each bar is hoverable (tooltip) and
 * clickable (jumps to its session, when wired up).
 *
 * Bars are rendered as `role="button"` spans, not native <button>s, so the
 * component can live inside an outer <button> (e.g. the agent card) without
 * nesting interactive controls. Click handler stops propagation.
 */
export function UptimeBars({ runs, label, onRunClick }: UptimeBarsProps) {
  const total = runs.length
  const successCount = runs.filter((r) => r.status === 'success').length
  const allGood = total > 0 && successCount === total
  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex items-center gap-2 text-xs">
        <div className="flex items-center gap-0.5 shrink-0">
          {runs.map((run, i) => {
            const isClickable = run.status !== 'empty'
            const handleActivate = (e: React.SyntheticEvent) => {
              e.stopPropagation()
              if (isClickable) onRunClick?.(run, i)
            }
            return (
              <Tooltip key={i}>
                <TooltipTrigger asChild>
                  <span
                    role={isClickable ? 'button' : undefined}
                    tabIndex={isClickable ? 0 : -1}
                    aria-label={
                      isClickable
                        ? `${STATUS_LABELS[run.status]}${run.startedAt ? ` · ${formatRunTime(run.startedAt)}` : ''}`
                        : STATUS_LABELS[run.status]
                    }
                    onClick={handleActivate}
                    onKeyDown={(e) => {
                      if (!isClickable) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        handleActivate(e)
                      }
                    }}
                    className={cn(
                      'inline-block h-3 w-[3px] rounded-full transition-opacity',
                      STATUS_CLASSES[run.status],
                      isClickable && 'cursor-pointer hover:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1'
                    )}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  <div className="font-medium">{STATUS_LABELS[run.status]}</div>
                  {run.startedAt && (
                    <div className="text-muted-foreground tabular-nums">
                      {formatRunTime(run.startedAt)}
                    </div>
                  )}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
        <span
          className={cn(
            'tabular-nums shrink-0',
            allGood ? 'text-green-500/80' : 'text-muted-foreground'
          )}
        >
          {successCount}/{total}
        </span>
        <span className="text-muted-foreground shrink-0">·</span>
        <span className="text-foreground truncate">{label}</span>
      </div>
    </TooltipProvider>
  )
}
