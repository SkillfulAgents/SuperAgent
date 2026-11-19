import { defineToolRenderer } from '../renderer-types'
import { Plug } from 'lucide-react'
import type { ToolRendererProps } from '../renderer-types'
import { Field, ResultField } from '../ui/shared'
import { formatProviderName } from '@shared/lib/agent-integrations/presentation'
import { requestIntegrationSetupDef } from './definition'

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { provider, reason } = requestIntegrationSetupDef.parseInput(input)
  return (
    <div className="space-y-2">
      {provider && <Field label="Provider" className="font-medium">{formatProviderName(provider)}</Field>}
      {reason && <Field label="Reason">{reason}</Field>}
      {result && <ResultField result={result} isError={isError} />}
    </div>
  )
}

export const requestIntegrationSetupRenderer = defineToolRenderer(requestIntegrationSetupDef, {
  icon: Plug,
  ExpandedView,
})
