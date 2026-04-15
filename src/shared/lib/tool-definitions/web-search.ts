export interface WebSearchInput {
  query?: string
}

function parseInput(input: unknown): WebSearchInput {
  return typeof input === 'object' && input !== null ? (input as WebSearchInput) : {}
}

function getSummary(input: unknown): string | null {
  return parseInput(input).query ?? null
}

export const webSearchDef = { displayName: 'Web Search', iconName: 'Globe', parseInput, getSummary } as const
