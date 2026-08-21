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

export const requestSecretDef = { displayName: 'Request Secret', parseInput, getSummary } as const
