export class McpReplacedError extends Error {
  readonly replacementMcpId: string

  constructor(mcpId: string) {
    super('The MCP connection was replaced for this agent')
    this.name = 'McpReplacedError'
    this.replacementMcpId = mcpId
  }
}

export function getReplacementMcpId(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const id = (error as { replacementMcpId?: unknown }).replacementMcpId
  return typeof id === 'string' && id ? id : undefined
}
