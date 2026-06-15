
import { KeyRound } from 'lucide-react'
import type { ToolRenderer, ToolRendererProps, StreamingToolRendererProps } from './types'
import { Field, ResultField } from './shared'
import { requestSecretDef, type RequestSecretInput } from '@shared/lib/tool-definitions/request-secret'

function parseRequestSecretInput(input: unknown): RequestSecretInput {
  if (typeof input === 'object' && input !== null) {
    return input as RequestSecretInput
  }
  return {}
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { secretName, reason } = parseRequestSecretInput(input)

  return (
    <div className="space-y-2">
      {secretName && <Field label="Secret" className="font-mono">{secretName}</Field>}
      {reason && <Field label="Reason">{reason}</Field>}
      {result && <ResultField result={result} isError={isError} />}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: RequestSecretInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  return (
    <div className="space-y-2">
      <Field label="Secret" className="font-mono">
        {parsed.secretName || <span className="text-muted-foreground italic">...</span>}
      </Field>
      {parsed.reason && (
        <Field label="Reason">
          {parsed.reason}
          <span className="animate-pulse">|</span>
        </Field>
      )}
    </div>
  )
}

export const requestSecretRenderer: ToolRenderer = {
  displayName: 'Request Secret',
  icon: KeyRound,
  getSummary: requestSecretDef.getSummary,
  ExpandedView,
  StreamingView,
}
