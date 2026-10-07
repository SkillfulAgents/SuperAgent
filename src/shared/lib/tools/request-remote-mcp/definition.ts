import { waitingInputNotification, type RequestDefinition } from '../requests/definition'

export interface RequestRemoteMcpInput {
  url?: string
  name?: string
  reason?: string
  authHint?: 'oauth' | 'bearer'
  clientId?: string
  clientName?: string
}

function parseInput(input: unknown): RequestRemoteMcpInput {
  return typeof input === 'object' && input !== null ? (input as RequestRemoteMcpInput) : {}
}

function getSummary(input: unknown): string | null {
  const { name, url } = parseInput(input)
  return name || url || null
}

export const requestRemoteMcpDef = {
  hideToolStatusInChat: true,
  showWaitingForInput: true,
  displayName: 'Request MCP Server',
  parseInput,
  getSummary,
  request: {
    kind: 'remote_mcp',
    getNotification: waitingInputNotification('needs access to an MCP server'),
    describeVoice: (request) => `The agent needs the user to connect ${request.name || 'an MCP server'} through the application's connection card.${request.reason ? ` Reason: ${request.reason}` : ''}`,
  } satisfies RequestDefinition<'remote_mcp'>,
} as const
