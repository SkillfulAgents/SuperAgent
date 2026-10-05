import { BellRing } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'
import { Field, ResultField } from './shared'
import { notifyUserDef, type NotifyUserInput } from '@shared/lib/tool-definitions/notify-user'

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { message, title } = notifyUserDef.parseInput(input)

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-xs">
        <BellRing className="h-3 w-3 text-foreground" />
        <span className="font-medium">{title || 'Notify user'}</span>
      </div>
      {message && <Field label="Message" className="whitespace-pre-wrap">{message}</Field>}
      {result && <ResultField result={result} isError={isError} />}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: NotifyUserInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <BellRing className="h-3 w-3 text-foreground" />
        <span className="font-medium">{parsed.title || 'Notify user'}</span>
        {!parsed.message && <span className="text-muted-foreground italic">Notifying...</span>}
      </div>
      {parsed.message && (
        <Field label="Message" className="whitespace-pre-wrap">
          {parsed.message}
          <span className="animate-pulse">|</span>
        </Field>
      )}
    </div>
  )
}

export const notifyUserRenderer: ToolRenderer = {
  displayName: 'Notify User',
  icon: BellRing,
  getSummary: notifyUserDef.getSummary,
  ExpandedView,
  StreamingView,
}
