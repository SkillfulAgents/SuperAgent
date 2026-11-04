import { waitingInputNotification, type RequestDefinition } from '../requests/definition'
import { formatProviderName } from '@shared/lib/agent-integrations/presentation'

export interface AddAgentIntegrationInput {
  provider?: string
  config?: Record<string, unknown>
  name?: string
  reason?: string
}

function parseInput(input: unknown): AddAgentIntegrationInput {
  return typeof input === 'object' && input !== null ? (input as AddAgentIntegrationInput) : {}
}

function getSummary(input: unknown): string | null {
  const { provider, name } = parseInput(input)
  const label = provider ? formatProviderName(provider) : null
  if (name) return `Add ${label ?? 'integration'}: ${name}`
  return label ? `Add ${label} integration` : null
}

export const addAgentIntegrationDef = {
  displayName: 'Add Agent Integration',
  parseInput,
  getSummary,
  request: {
    kind: 'integration_setup',
    // Only owner-managed providers park on the owner: the host registers the
    // card when it decides that, so the call itself establishes no wait.
    syncsAwaitingItself: true,
    getNotification: waitingInputNotification('needs its owner to set up an integration'),
    describeVoice: (request) => `The agent asked its owner to set up ${formatProviderName(request.provider)} for it, in the application's setup card.${request.reason ? ` Reason: ${request.reason}` : ''}`,
  } satisfies RequestDefinition<'integration_setup'>,
} as const
