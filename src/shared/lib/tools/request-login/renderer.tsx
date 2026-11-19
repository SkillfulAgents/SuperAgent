import { defineToolRenderer } from '../renderer-types'
import { KeyRound } from 'lucide-react'
import type { ToolRendererProps, StreamingToolRendererProps } from '../renderer-types'
import { Field, FieldLabel, ResultField } from '../ui/shared'
import { requestLoginDef, type RequestLoginInput } from './definition'
import { summarizeLoginFields } from './login-request'

const KIND_LABELS = {
  username: 'username',
  password: 'password',
  otp: 'one-time code',
  text: 'text',
} as const

function FieldsBlock({ fields }: { fields: unknown }) {
  const summary = summarizeLoginFields(fields)
  if (summary.length === 0) return null
  return (
    <div>
      <FieldLabel>Fields</FieldLabel>
      <ul className="bg-background rounded p-2 text-xs space-y-0.5">
        {summary.map((field, i) => (
          <li key={i}>
            {field.label} <span className="text-muted-foreground">({KIND_LABELS[field.kind]})</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { message, fields } = requestLoginDef.parseInput(input)
  return (
    <div className="space-y-2">
      {message && <Field label="Message">{message}</Field>}
      <FieldsBlock fields={fields} />
      {result && <ResultField result={result} isError={isError} />}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: RequestLoginInput = {}
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
      <FieldsBlock fields={parsed.fields} />
    </div>
  )
}

export const requestLoginRenderer = defineToolRenderer(requestLoginDef, {
  icon: KeyRound,
  ExpandedView,
  StreamingView,
})
