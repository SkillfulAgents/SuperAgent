import { MoonStar, Globe } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'
import { Field, ResultField } from './shared'
import { scheduleResumeDef, type ScheduleResumeInput } from '@shared/lib/tool-definitions/schedule-resume'

const parseScheduleResumeInput = scheduleResumeDef.parseInput

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { wakeTime, note, timezone } = parseScheduleResumeInput(input)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1.5">
          <MoonStar className="h-3 w-3 text-foreground" />
          <span className="font-medium">Auto-resume</span>
        </div>
        {wakeTime && (
          <div className="text-muted-foreground">{wakeTime.replace(/^at\s+/i, '')}</div>
        )}
        {timezone && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <Globe className="h-3 w-3" />
            <span>{timezone.replace(/_/g, ' ')}</span>
          </div>
        )}
      </div>

      {note && <Field label="Wake Note" className="whitespace-pre-wrap">{note}</Field>}
      {result && <ResultField result={result} isError={isError} />}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: ScheduleResumeInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <MoonStar className="h-3 w-3 text-foreground" />
        <span className="font-medium">Auto-resume</span>
        {parsed.wakeTime ? (
          <span className="text-muted-foreground">{parsed.wakeTime.replace(/^at\s+/i, '')}</span>
        ) : (
          <span className="text-muted-foreground italic">Scheduling resume...</span>
        )}
      </div>

      {parsed.note && (
        <Field label="Wake Note" className="whitespace-pre-wrap">
          {parsed.note}
          <span className="animate-pulse">|</span>
        </Field>
      )}
    </div>
  )
}

export const scheduleResumeRenderer: ToolRenderer = {
  displayName: 'Schedule Resume',
  icon: MoonStar,
  getSummary: scheduleResumeDef.getSummary,
  ExpandedView,
  StreamingView,
}
