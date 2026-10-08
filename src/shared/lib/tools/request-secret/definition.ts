import { waitingInputNotification, type RequestDefinition } from '../requests/definition'

export interface RequestSecretInput {
  secretName?: string
  reason?: string
  serviceName?: string
  showAsConnection?: boolean
}

function parseInput(input: unknown): RequestSecretInput {
  return typeof input === 'object' && input !== null ? (input as RequestSecretInput) : {}
}

function getSummary(input: unknown): string | null {
  return parseInput(input).secretName || null
}

export const requestSecretDef = {
  hideToolStatusInChat: true,
  showWaitingForInput: true,
  displayName: 'Request Secret',
  parseInput,
  getSummary,
  request: {
    kind: 'secret',
    getNotification: waitingInputNotification('needs a secret value'),
    describeVoice: (request) => `The agent needs the secret ${request.secretName} entered securely in the application's secret card.${request.reason ? ` Reason: ${request.reason}` : ''}`,
  } satisfies RequestDefinition<'secret'>,
} as const
