
import { Clock, Repeat, CalendarClock } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'

interface ScheduleTaskInput {
  scheduleType?: 'at' | 'cron'
  scheduleExpression?: string
  prompt?: string
  name?: string
}

function parseScheduleTaskInput(input: unknown): ScheduleTaskInput {
  if (typeof input === 'object' && input !== null) {
    return input as ScheduleTaskInput
  }
  return {}
}

/**
 * Convert a cron expression to a human-readable string
 */
function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts

  // Common patterns
  if (cron === '* * * * *') return 'Every minute'
  if (cron === '0 * * * *') return 'Every hour'
  if (cron === '0 0 * * *') return 'Daily at midnight'
  if (cron === '0 0 * * 0') return 'Weekly on Sunday'
  if (cron === '0 0 1 * *') return 'Monthly on the 1st'

  // */N patterns
  if (minute.startsWith('*/') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const interval = minute.slice(2)
    return `Every ${interval} minutes`
  }
  if (minute === '0' && hour.startsWith('*/') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const interval = hour.slice(2)
    return `Every ${interval} hours`
  }

  // Specific time patterns
  if (minute.match(/^\d+$/) && hour.match(/^\d+$/) && dayOfMonth === '*' && month === '*') {
    const h = parseInt(hour, 10)
    const m = parseInt(minute, 10)
    const time = `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`

    if (dayOfWeek === '*') return `Daily at ${time}`
    if (dayOfWeek === '1-5') return `Weekdays at ${time}`
    if (dayOfWeek === '0,6') return `Weekends at ${time}`
  }

  return cron
}

function getSummary(input: unknown): string | null {
  const { name, scheduleType, scheduleExpression } = parseScheduleTaskInput(input)
  const isRecurring = scheduleType === 'cron'
  const prefix = isRecurring ? '🔁' : '📅'

  // Get human-readable schedule
  let schedule = ''
  if (scheduleType === 'cron' && scheduleExpression) {
    schedule = cronToHuman(scheduleExpression)
  } else if (scheduleExpression) {
    schedule = scheduleExpression.replace(/^at\s+/i, '')
  }

  if (name && schedule) {
    return `${prefix} ${name} · ${schedule}`
  }

  if (name) {
    return `${prefix} ${name}`
  }

  if (schedule) {
    return `${prefix} ${schedule}`
  }

  return null
}

function parseResult(result: unknown): string | null {
  if (!result) return null

  // If it's already parsed as an array (e.g., [{type: "text", text: "..."}])
  if (Array.isArray(result) && result[0]?.text) {
    return result[0].text
  }

  // If it's a string, try to parse as JSON
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result)
      if (Array.isArray(parsed) && parsed[0]?.text) {
        return parsed[0].text
      }
    } catch {
      // Not JSON, use as-is
    }
    return result
  }

  // If it's an object with text property
  if (typeof result === 'object' && result !== null && 'text' in result) {
    return (result as { text: string }).text
  }

  // Fallback: stringify
  return JSON.stringify(result)
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { scheduleType, scheduleExpression, prompt, name } = parseScheduleTaskInput(input)
  const displayResult = parseResult(result ?? null)
  const isRecurring = scheduleType === 'cron'

  return (
    <div className="space-y-3">
      {/* Schedule info header */}
      <div className="flex items-center gap-4 text-sm">
        <div className="flex items-center gap-1.5">
          {isRecurring ? (
            <Repeat className="h-4 w-4 text-blue-500" />
          ) : (
            <CalendarClock className="h-4 w-4 text-amber-500" />
          )}
          <span className="font-medium">
            {isRecurring ? 'Recurring' : 'One-time'}
          </span>
        </div>
        {scheduleExpression && (
          <div className="text-muted-foreground">
            {isRecurring ? cronToHuman(scheduleExpression) : scheduleExpression.replace(/^at\s+/i, '')}
          </div>
        )}
      </div>

      {/* Task name */}
      {name && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Task Name</div>
          <div className="bg-background rounded p-2 text-sm font-medium">
            {name}
          </div>
        </div>
      )}

      {/* Prompt */}
      {prompt && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Prompt</div>
          <div className="border-2 border-dashed border-muted rounded-lg p-3 bg-muted/20">
            <div className="text-sm whitespace-pre-wrap">{prompt}</div>
          </div>
        </div>
      )}

      {/* Result */}
      {displayResult && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            {isError ? 'Error' : 'Result'}
          </div>
          <div
            className={`rounded p-2 text-xs ${
              isError
                ? 'bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200'
                : 'bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200'
            }`}
          >
            {displayResult}
          </div>
        </div>
      )}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: ScheduleTaskInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  const isRecurring = parsed.scheduleType === 'cron'

  return (
    <div className="space-y-3">
      {/* Schedule type indicator */}
      <div className="flex items-center gap-2 text-sm">
        {parsed.scheduleType ? (
          <>
            {isRecurring ? (
              <Repeat className="h-4 w-4 text-blue-500" />
            ) : (
              <CalendarClock className="h-4 w-4 text-amber-500" />
            )}
            <span className="font-medium">
              {isRecurring ? 'Recurring' : 'One-time'}
            </span>
            {parsed.scheduleExpression && (
              <span className="text-muted-foreground">
                {isRecurring ? cronToHuman(parsed.scheduleExpression) : parsed.scheduleExpression.replace(/^at\s+/i, '')}
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground italic">Configuring schedule...</span>
        )}
      </div>

      {/* Task name */}
      {parsed.name && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Task Name</div>
          <div className="bg-background rounded p-2 text-sm font-medium">
            {parsed.name}
          </div>
        </div>
      )}

      {/* Prompt */}
      {parsed.prompt && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">Prompt</div>
          <div className="border-2 border-dashed border-muted rounded-lg p-3 bg-muted/20">
            <div className="text-sm whitespace-pre-wrap">
              {parsed.prompt}
              <span className="animate-pulse">|</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export const scheduleTaskRenderer: ToolRenderer = {
  displayName: 'Schedule Task',
  icon: Clock,
  getSummary,
  ExpandedView,
  StreamingView,
}
