import { waitingInputNotification, type RequestDefinition } from '../requests/definition'

import { getProvider } from '@shared/lib/account-providers/service-catalog'

export interface RequestConnectedAccountInput {
  toolkit?: string
  reason?: string
}

function parseInput(input: unknown): RequestConnectedAccountInput {
  return typeof input === 'object' && input !== null ? (input as RequestConnectedAccountInput) : {}
}

function getSummary(input: unknown): string | null {
  const { toolkit } = parseInput(input)
  if (!toolkit) return null
  const provider = getProvider(toolkit.toLowerCase())
  return provider?.displayName || toolkit
}

export const requestConnectedAccountDef = {
  hideToolStatusInChat: true,
  showWaitingForInput: true,
  displayName: 'Request Connected Account',
  parseInput,
  getSummary,
  request: {
    kind: 'connected_account',
    getNotification: waitingInputNotification('needs account access'),
    describeVoice: (request) => `The agent needs the user to select or connect a ${request.toolkit} account in the application's connection card.${request.reason ? ` Reason: ${request.reason}` : ''}`,
  } satisfies RequestDefinition<'connected_account'>,
} as const
