import { waitingInputNotification, type RequestDefinition } from '../requests/definition'
import { formatProviderName } from '@shared/lib/agent-integrations/presentation'

export interface RequestIntegrationSetupInput {
  provider?: string
  reason?: string
  /** Starting values for the setup form; never credentials. */
  prefill?: Record<string, unknown>
}

function parseInput(input: unknown): RequestIntegrationSetupInput {
  return typeof input === 'object' && input !== null ? (input as RequestIntegrationSetupInput) : {}
}

function getSummary(input: unknown): string | null {
  const { provider } = parseInput(input)
  return provider ? formatProviderName(provider) : null
}

export const requestIntegrationSetupDef = {
  hideToolStatusInChat: true,
  showWaitingForInput: true,
  displayName: 'Request Integration Setup',
  parseInput,
  getSummary,
  request: {
    kind: 'integration_setup',
    getNotification: waitingInputNotification('needs you to set up an integration'),
    describeVoice: (request) => `The agent asked the user to set up ${formatProviderName(request.provider)} for it, in the application's setup card.${request.reason ? ` Reason: ${request.reason}` : ''}`,
  } satisfies RequestDefinition<'integration_setup'>,
} as const
