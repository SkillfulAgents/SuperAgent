
import { Clock, Repeat, CalendarClock, Globe } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'
import { scheduleTaskDef, cronToHuman, type ScheduleTaskInput } from '@shared/lib/tool-definitions/schedule-task'

const parseScheduleTaskInput = scheduleTaskDef.parseInput

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
  const { scheduleType, scheduleExpression, prompt, name, timezone } = parseScheduleTaskInput(input)
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
        {timezone && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <Globe className="h-3.5 w-3.5" />
            <span>{timezone.replace(/_/g, ' ')}</span>
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
  getSummary: scheduleTaskDef.getSummary,
  ExpandedView,
  StreamingView,
}
