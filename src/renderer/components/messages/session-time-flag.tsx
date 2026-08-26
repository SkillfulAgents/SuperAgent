import {
  addMinutes,
  differenceInCalendarDays,
  format,
  formatDistanceStrict,
  isAfter,
  isSameDay,
  isValid,
  subDays,
} from 'date-fns'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'

const SESSION_GAP_MINUTES = 15

/** True only when the user message is strictly more than 15 minutes later. */
export function isSessionTimeGap(userDate: Date, lastAssistantDate: Date | null): boolean {
  return (
    lastAssistantDate !== null &&
    isValid(userDate) &&
    isValid(lastAssistantDate) &&
    isAfter(userDate, addMinutes(lastAssistantDate, SESSION_GAP_MINUTES))
  )
}

/** Human-friendly transcript timestamp with explicit day and week tiers. */
export function formatSessionTimeLabel(date: Date, now: Date = new Date()): string {
  if (!isValid(date) || !isValid(now)) return ''

  const time = format(date, 'h:mm a')
  if (isSameDay(date, now)) return `Today at ${time}`
  if (isSameDay(date, subDays(now, 1))) return `Yesterday at ${time}`

  const daysAgo = differenceInCalendarDays(now, date)
  if (daysAgo >= 2 && daysAgo < 7) return `${daysAgo} days ago`
  if (daysAgo >= 7 && daysAgo < 30) {
    const weeksAgo = Math.floor(daysAgo / 7)
    return `${weeksAgo} ${weeksAgo === 1 ? 'week' : 'weeks'} ago`
  }

  return formatDistanceStrict(date, now, {
    addSuffix: true,
    roundingMethod: 'floor',
  })
}

export function SessionTimeFlag({ date }: { date: Date }) {
  const label = formatSessionTimeLabel(date)
  if (!label) return null

  const exactTime = format(date, 'PPpp')

  return (
    <div className="flex justify-center" data-testid="session-time-flag">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <time
              dateTime={date.toISOString()}
              className="cursor-default text-sm font-normal tabular-nums text-muted-foreground/80"
            >
              {label}
            </time>
          </TooltipTrigger>
          <TooltipContent side="top" className="tabular-nums">
            {exactTime}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
