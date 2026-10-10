import { defineToolRenderer } from '../renderer-types'
import { Blocks } from 'lucide-react'
import type { ToolRendererProps, StreamingToolRendererProps } from '../renderer-types'
import { Field, ResultField } from '../ui/shared'
import { requestConnectedAccountDef, type RequestConnectedAccountInput } from './definition'
import { getProvider } from '@shared/lib/account-providers/service-catalog'

const parseRequestConnectedAccountInput = requestConnectedAccountDef.parseInput

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { toolkit, reason } = parseRequestConnectedAccountInput(input)
  const provider = toolkit ? getProvider(toolkit.toLowerCase()) : null

  return (
    <div className="space-y-2">
      {toolkit && (
        <Field label="Service" className="font-medium capitalize">
          {provider?.displayName || toolkit}
        </Field>
      )}
      {reason && <Field label="Reason">{reason}</Field>}
      {result && <ResultField result={result} isError={isError} />}
    </div>
  )
}

function StreamingView({ partialInput }: StreamingToolRendererProps) {
  let parsed: RequestConnectedAccountInput = {}
  try {
    parsed = JSON.parse(partialInput)
  } catch {
    // Still streaming
  }

  const provider = parsed.toolkit ? getProvider(parsed.toolkit.toLowerCase()) : null

  return (
    <div className="space-y-2">
      <Field label="Service" className="font-medium capitalize">
        {provider?.displayName || parsed.toolkit || <span className="text-muted-foreground italic">...</span>}
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

export const requestConnectedAccountRenderer = defineToolRenderer(requestConnectedAccountDef, {
  icon: Blocks,
  ExpandedView,
  StreamingView,
})
