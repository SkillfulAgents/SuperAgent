import { getProvider } from '@shared/lib/composio/providers'

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

export const requestConnectedAccountDef = { displayName: 'Request Connected Account', iconName: 'Link2', parseInput, getSummary } as const
