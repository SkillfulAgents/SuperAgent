export interface RequestRemoteMcpInput {
  url?: string
  name?: string
  reason?: string
  authHint?: 'oauth' | 'bearer'
}

function parseInput(input: unknown): RequestRemoteMcpInput {
  return typeof input === 'object' && input !== null ? (input as RequestRemoteMcpInput) : {}
}

function getSummary(input: unknown): string | null {
  const { name, url } = parseInput(input)
  return name || url || null
}

export const requestRemoteMcpDef = { displayName: 'Request MCP Server', iconName: 'Plug', parseInput, getSummary } as const
