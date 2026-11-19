import { defineToolRenderer } from '../renderer-types'
import { Plus } from 'lucide-react'
import type { ToolRendererProps } from '../renderer-types'
import { Field, ResultField } from '../ui/shared'
import { formatProviderName } from '@shared/lib/agent-integrations/presentation'
import { addAgentIntegrationDef } from './definition'

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { provider, name, reason } = addAgentIntegrationDef.parseInput(input)
  return (
    <div className="space-y-2">
      {provider && <Field label="Provider" className="font-medium">{formatProviderName(provider)}</Field>}
      {name && <Field label="Name">{name}</Field>}
      {reason && <Field label="Reason">{reason}</Field>}
      {result && <ResultField result={result} isError={isError} />}
    </div>
  )
}

export const addAgentIntegrationRenderer = defineToolRenderer(addAgentIntegrationDef, {
  icon: Plus,
  ExpandedView,
})
