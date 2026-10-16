import { defineToolRenderer } from '../renderer-types'
import { Hand } from 'lucide-react'
import type { ToolRendererProps, StreamingToolRendererProps } from '../renderer-types'
import { Field, FieldLabel, ResultField } from '../ui/shared'
import { requestBrowserInputDef, type RequestBrowserInputInput } from './definition'

function RequirementsBlock({ requirements }: { requirements: string[] }) {
  return (
    <div>
      <FieldLabel>Requirements</FieldLabel>
      <ul className="bg-background rounded p-2 text-xs list-disc list-inside space-y-0.5">
        {requirements.map((req, i) => (
          <li key={i}>{req}</li>
        ))}
      </ul>
    </div>
  )
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { message, requirements } = requestBrowserInputDef.parseInput(input)

  return (
    <div className="space-y-2">
      {message && <Field label="Message">{message}</Field>}
      {Array.isArray(requirements) && requirements.length > 0 && <RequirementsBlock requirements={requirements} />}
      {result && <ResultField result={result} isError={isError} />}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: RequestBrowserInputInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  return (
    <div className="space-y-2">
      <Field label="Message">
        {parsed.message || <span className="text-muted-foreground italic">...</span>}
        <span className="animate-pulse">|</span>
      </Field>
      {Array.isArray(parsed.requirements) && parsed.requirements.length > 0 && (
        <RequirementsBlock requirements={parsed.requirements} />
      )}
    </div>
  )
}

export const requestBrowserInputRenderer = defineToolRenderer(requestBrowserInputDef, {
  icon: Hand,
  ExpandedView,
  StreamingView,
})
