export interface ConnectedAccountProjectionSource {
  id: string
  toolkitSlug: string
  displayName: string
  status: string
}

export type ConnectedAccountRuntimeStatus = 'active' | 'expired' | 'revoked'

export interface ConnectedAccountRuntimeEntry {
  name: string
  id: string
  status: ConnectedAccountRuntimeStatus
}

export interface RemoteMcpProjectionSource {
  id: string
  name: string
  status: string
  toolsJson: string | null
}

export interface RemoteMcpRuntimeConfig {
  id: string
  name: string
  status: 'active' | 'auth_required'
  proxyUrl: string
  tools: Array<{ name: string }>
}

function parseToolNames(toolsJson: string | null): Array<{ name: string }> {
  if (!toolsJson) return []
  try {
    const tools = JSON.parse(toolsJson) as unknown
    if (!Array.isArray(tools)) return []
    return tools.flatMap((tool) => {
      if (
        typeof tool === 'object' &&
        tool !== null &&
        'name' in tool &&
        typeof tool.name === 'string'
      ) {
        return [{ name: tool.name }]
      }
      return []
    })
  } catch {
    return []
  }
}

export function buildConnectedAccountsProjection(
  accounts: ConnectedAccountProjectionSource[],
): Record<string, ConnectedAccountRuntimeEntry[]> {
  const metadata: Record<string, ConnectedAccountRuntimeEntry[]> = {}
  const assignedAccounts = accounts
    // Keep reconnectable accounts in the runtime. The first proxy request made
    // with one of these IDs parks while the host surfaces the reconnect card.
    // Dropping them here makes an assigned account look entirely unavailable.
    .filter((account) =>
      account.status === 'active' ||
      account.status === 'expired' ||
      account.status === 'revoked'
    )
    .sort((a, b) =>
      a.toolkitSlug.localeCompare(b.toolkitSlug) ||
      a.id.localeCompare(b.id),
    )

  for (const account of assignedAccounts) {
    metadata[account.toolkitSlug] ??= []
    metadata[account.toolkitSlug].push({
      name: account.displayName,
      id: account.id,
      status: account.status as ConnectedAccountRuntimeStatus,
    })
  }

  return metadata
}

export function buildRemoteMcpProjection(
  mcps: RemoteMcpProjectionSource[],
  agentSlug: string,
  hostApiBaseUrl: string,
): RemoteMcpRuntimeConfig[] {
  return mcps
    // Keep auth-required servers in the runtime. Their MCP handshake reaches
    // the host proxy, which parks it and surfaces the reconnect card. Dropping
    // them here makes the agent believe an assigned MCP does not exist.
    .filter((mcp) => mcp.status === 'active' || mcp.status === 'auth_required')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((mcp) => ({
      id: mcp.id,
      name: mcp.name,
      status: mcp.status as 'active' | 'auth_required',
      proxyUrl: `${hostApiBaseUrl}/api/mcp-proxy/${agentSlug}/${mcp.id}`,
      tools: parseToolNames(mcp.toolsJson),
    }))
}
