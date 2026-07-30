import { Rocket, CheckCircle2, PauseCircle, RefreshCw, OctagonAlert } from 'lucide-react'
import type { ApiAutopilotReview } from '@shared/lib/types/api'
import { cn } from '@shared/lib/utils'

interface AutopilotReviewItemProps {
  item: ApiAutopilotReview
}

const VERDICT_DISPLAY = {
  done: {
    title: 'Autopilot complete',
    icon: CheckCircle2,
    tone: 'text-green-600 dark:text-green-400',
    chip: 'bg-green-500/15',
  },
  continue: {
    title: 'Autopilot continuing',
    icon: RefreshCw,
    tone: 'text-purple-600 dark:text-purple-400',
    chip: 'bg-purple-500/15',
  },
  blocked: {
    title: 'Autopilot paused — needs you',
    icon: PauseCircle,
    tone: 'text-orange-600 dark:text-orange-400',
    chip: 'bg-orange-500/15',
  },
  escalated: {
    title: 'Autopilot escalated to you',
    icon: OctagonAlert,
    tone: 'text-orange-600 dark:text-orange-400',
    chip: 'bg-orange-500/15',
  },
} as const

/**
 * Timeline card for one autopilot watchdog decision: the reviewer looked at a
 * stop and either let the session rest, restarted it with a nudge, or handed
 * control back to the user.
 */
export function AutopilotReviewItem({ item }: AutopilotReviewItemProps) {
  const display = VERDICT_DISPLAY[item.verdict] ?? VERDICT_DISPLAY.escalated
  const Icon = display.icon

  return (
    <div
      className="rounded-[12px] border border-purple-300/50 dark:border-purple-700/40 bg-purple-50/40 dark:bg-purple-950/15 p-4"
      data-testid="autopilot-review-item"
    >
      <div className="flex items-start gap-3">
        <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', display.chip)}>
          <Icon className={cn('h-4 w-4', display.tone)} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium text-foreground">{display.title}</h4>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Rocket className="h-3 w-3" />
              {item.iteration != null && item.maxIterations != null
                ? `review ${item.iteration}/${item.maxIterations}`
                : 'watchdog review'}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words">
            {item.reasoning}
          </p>
          {item.verdict === 'continue' && item.nudge && (
            <p className="mt-1.5 text-xs text-foreground/80 whitespace-pre-wrap break-words">
              <span className="font-medium">Next:</span> {item.nudge}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
