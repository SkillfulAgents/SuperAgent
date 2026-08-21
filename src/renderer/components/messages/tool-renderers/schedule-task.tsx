
import { Calendar, Repeat, CalendarClock, Globe } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'
import { Field, ResultField } from './shared'
import { scheduleTaskDef, cronToHuman, type ScheduleTaskInput } from '@shared/lib/tool-definitions/schedule-task'

const parseScheduleTaskInput = scheduleTaskDef.parseInput

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { scheduleType, scheduleExpression, prompt, name, timezone } = parseScheduleTaskInput(input)
  const isRecurring = scheduleType === 'cron'

  return (
    <div className="space-y-3">
      {/* Schedule info header */}
      <div className="flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          {isRecurring ? (
            <Repeat className="h-3 w-3 text-foreground" />
          ) : (
            <CalendarClock className="h-3 w-3 text-foreground" />
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
            <Globe className="h-3 w-3" />
            <span>{timezone.replace(/_/g, ' ')}</span>
          </div>
        )}
      </div>

      {name && <Field label="Task Name" className="font-medium">{name}</Field>}
      {prompt && <Field label="Prompt" className="whitespace-pre-wrap">{prompt}</Field>}
      {result && <ResultField result={result} isError={isError} />}
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
      <div className="flex items-center gap-2 text-xs">
        {parsed.scheduleType ? (
          <>
            {isRecurring ? (
              <Repeat className="h-3 w-3 text-foreground" />
            ) : (
              <CalendarClock className="h-3 w-3 text-foreground" />
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

      {parsed.name && <Field label="Task Name" className="font-medium">{parsed.name}</Field>}
      {parsed.prompt && (
        <Field label="Prompt" className="whitespace-pre-wrap">
          {parsed.prompt}
          <span className="animate-pulse">|</span>
        </Field>
      )}
    </div>
  )
}

export const scheduleTaskRenderer: ToolRenderer = {
  displayName: 'Schedule Task',
  icon: Calendar,
  getSummary: scheduleTaskDef.getSummary,
  ExpandedView,
  StreamingView,
}
