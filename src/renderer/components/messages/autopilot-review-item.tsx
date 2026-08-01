import { useState } from 'react'
import { Rocket, CheckCircle2, PauseCircle, RefreshCw, OctagonAlert, ShieldCheck, ShieldX, ChevronDown, ChevronRight } from 'lucide-react'
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

export function isAutopilotApprovalItem(item: ApiAutopilotReview): boolean {
  return item.verdict === 'approved' || item.verdict === 'denied'
}

/**
 * Collapsed row (tool-call style) for a run of consecutive approval-reviewer
 * decisions. One decision shows its action inline; several collapse into
 * "Autopilot approved N requests". Expanding lists every judged action with
 * the reviewer's reason.
 */
export function AutopilotApprovalGroup({ items }: { items: ApiAutopilotReview[] }) {
  const [expanded, setExpanded] = useState(false)
  const denied = items.filter((i) => i.verdict === 'denied').length
  const approved = items.length - denied

  const label =
    items.length === 1
      ? items[0].verdict === 'denied'
        ? 'Autopilot denied a request'
        : 'Autopilot approved a request'
      : denied === 0
        ? `Autopilot approved ${items.length} requests`
        : approved === 0
          ? `Autopilot denied ${items.length} requests`
          : `Autopilot reviewed ${items.length} requests (${denied} denied)`
  const HeaderIcon = denied > 0 && approved === 0 ? ShieldX : ShieldCheck

  return (
    <div className="text-sm border border-border/70 rounded-md overflow-hidden" data-testid="autopilot-approval-group">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} autopilot approval decisions`}
        onClick={() => setExpanded((current) => !current)}
        className={cn('flex w-full items-center gap-2 pl-2 pr-2 py-1.5 group hover:bg-muted/50 transition-colors', expanded && 'bg-muted/50')}
      >
        <HeaderIcon className="h-3.5 w-3.5 shrink-0 text-purple-500/70 group-hover:text-purple-500 transition-colors" />
        <span className="font-sans font-normal shrink-0 text-sm leading-none text-foreground/65 group-hover:text-foreground transition-colors">
          {label}
        </span>
        {items.length === 1 && items[0].action && (
          <>
            <span aria-hidden className="shrink-0 text-foreground/40 group-hover:text-muted-foreground text-sm leading-none transition-colors">→</span>
            <span className="text-muted-foreground/70 group-hover:text-muted-foreground truncate text-xs leading-none transition-colors">
              {items[0].action}
            </span>
          </>
        )}
        <span className="relative shrink-0 flex h-4 w-4 items-center justify-center ml-auto text-muted-foreground/60 group-hover:text-muted-foreground transition-colors">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border/70 bg-muted/50 px-3 py-2 space-y-2.5">
          {items.map((item) => {
            const isDenied = item.verdict === 'denied'
            const Icon = isDenied ? ShieldX : ShieldCheck
            return (
              <div key={item.id} className="flex items-start gap-2">
                <Icon
                  className={cn(
                    'mt-0.5 h-3.5 w-3.5 shrink-0',
                    isDenied ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                  )}
                />
                <div className="min-w-0 flex-1">
                  {item.action && (
                    <p className="font-mono text-xs text-foreground/80 break-all">{item.action}</p>
                  )}
                  <p className="mt-0.5 text-xs text-muted-foreground whitespace-pre-wrap break-words">
                    {item.reasoning}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Timeline card for one autopilot watchdog decision: the reviewer looked at a
 * stop and either let the session rest, restarted it with a nudge, or handed
 * control back to the user. Approval-reviewer decisions render through
 * AutopilotApprovalGroup instead (message-list routes them there).
 */
export function AutopilotReviewItem({ item }: AutopilotReviewItemProps) {
  const display = VERDICT_DISPLAY[item.verdict as keyof typeof VERDICT_DISPLAY] ?? VERDICT_DISPLAY.escalated
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
