import type { ConnectedAccount } from '@renderer/hooks/use-connected-accounts'
import type { RemoteMcpServer } from '@renderer/hooks/use-remote-mcps'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { safeDate } from './utils'

export interface UnifiedRow {
  key: string
  id: string
  name: string
  subtitle?: string
  iconSlug?: string
  iconFallback: 'oauth' | 'mcp' | 'blocks'
  type: 'oauth' | 'mcp'
  date: string | number
  granted: boolean
  toolkit?: string
  mcpTools?: Array<{ name: string; description?: string }>
  mcpStatus?: RemoteMcpServer['status']
  mcpErrorMessage?: string | null
  accountStatus?: ConnectedAccount['status']
}

interface BuildArgs {
  allAccounts: ConnectedAccount[]
  allMcps: RemoteMcpServer[]
  /** Account IDs the agent currently has access to. Omit for global views. */
  agentAccountIds?: Set<string>
  /** MCP IDs the agent currently has access to. Omit for global views. */
  agentMcpIds?: Set<string>
  /** Optional optimistic overrides keyed by row.key. */
  grantOverrides?: Record<string, boolean>
}

/**
 * Build the unified list of OAuth + MCP rows. When `agentAccountIds` /
 * `agentMcpIds` are provided, rows are flagged `granted` based on those sets;
 * otherwise rows default to `granted: false` (used by the global Connections
 * settings tab where the granted/notGranted split is not relevant).
 */
export function buildUnifiedRows({
  allAccounts,
  allMcps,
  agentAccountIds,
  agentMcpIds,
  grantOverrides,
}: BuildArgs): UnifiedRow[] {
  const out: UnifiedRow[] = []

  for (const account of allAccounts) {
    const key = `account-${account.id}`
    const serverGranted = agentAccountIds?.has(account.id) ?? false
    out.push({
      key,
      id: account.id,
      name: account.displayName,
      subtitle: account.provider?.displayName ?? account.toolkitSlug,
      iconSlug: account.toolkitSlug,
      iconFallback: 'oauth',
      type: 'oauth',
      date: account.createdAt,
      granted: grantOverrides?.[key] ?? serverGranted,
      toolkit: account.toolkitSlug,
      accountStatus: account.status,
    })
  }

  for (const mcp of allMcps) {
    const key = `mcp-${mcp.id}`
    const serverGranted = agentMcpIds?.has(mcp.id) ?? false
    out.push({
      key,
      id: mcp.id,
      name: mcp.name,
      subtitle: mcp.url,
      iconSlug: COMMON_MCP_SERVERS.find((cs) => cs.url === mcp.url)?.slug,
      iconFallback: 'blocks',
      type: 'mcp',
      date: mcp.createdAt,
      granted: grantOverrides?.[key] ?? serverGranted,
      mcpTools: mcp.tools,
      mcpStatus: mcp.status,
      mcpErrorMessage: mcp.errorMessage,
    })
  }

  return out.sort(
    (a, b) => safeDate(b.date).getTime() - safeDate(a.date).getTime(),
  )
}
