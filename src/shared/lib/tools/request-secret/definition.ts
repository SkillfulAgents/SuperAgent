import { waitingInputNotification } from '../requests/definition'

export interface RequestSecretInput {
  secretName?: string
  reason?: string
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
  },
} as const
