import { waitingInputNotification } from '../requests/definition'

export interface RequestFileInput {
  description?: string
  fileTypes?: string
}

function parseInput(input: unknown): RequestFileInput {
  return typeof input === 'object' && input !== null ? (input as RequestFileInput) : {}
}

function getSummary(input: unknown): string | null {
  return parseInput(input).description || null
}

export const requestFileDef = {
  displayName: 'Request File',
  parseInput,
  getSummary,
  request: { getNotification: waitingInputNotification('needs a file from you') },
} as const
