export interface ConnectedAccountProjectionSource {
  id: string
  toolkitSlug: string
  displayName: string
  status: string
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
): Record<string, Array<{ name: string; id: string }>> {
  const metadata: Record<string, Array<{ name: string; id: string }>> = {}
  const activeAccounts = accounts
    .filter((account) => account.status === 'active')
    .sort((a, b) =>
      a.toolkitSlug.localeCompare(b.toolkitSlug) ||
      a.id.localeCompare(b.id),
    )

  for (const account of activeAccounts) {
    metadata[account.toolkitSlug] ??= []
    metadata[account.toolkitSlug].push({
      name: account.displayName,
      id: account.id,
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
    .filter((mcp) => mcp.status === 'active')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((mcp) => ({
      id: mcp.id,
      name: mcp.name,
      proxyUrl: `${hostApiBaseUrl}/api/mcp-proxy/${agentSlug}/${mcp.id}`,
      tools: parseToolNames(mcp.toolsJson),
    }))
}
