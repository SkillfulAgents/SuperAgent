import type { ConnectedAccount } from '@renderer/hooks/use-connected-accounts'
import type { RemoteMcpServer } from '@renderer/hooks/use-remote-mcps'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { getProvider } from '@shared/lib/account-providers/service-catalog'
import type {
  ForeignAgentConnectedAccount,
  ForeignAgentRemoteMcp,
} from '@shared/lib/agent-connections/public'
import { safeDate } from './utils'

export interface UnifiedRow {
  key: string
  id: string
  name: string
  subtitle?: string
  iconSlug?: string
  iconFallback: 'oauth' | 'mcp' | 'blocks'
  type: 'oauth' | 'mcp'
  date?: string | number
  granted: boolean
  /** Opaque link owned by another member; never navigable or mutable. */
  foreign?: true
  toolkit?: string
  mcpTools?: Array<{ name: string; description?: string }>
  mcpStatus?: RemoteMcpServer['status']
  mcpErrorMessage?: string | null
  accountStatus?: ConnectedAccount['status']
}

interface BuildArgs {
  allAccounts: ConnectedAccount[]
  allMcps: RemoteMcpServer[]
  foreignAccounts?: ForeignAgentConnectedAccount[]
  foreignMcps?: ForeignAgentRemoteMcp[]
  /** Account IDs the agent currently has access to. Omit for global views. */
  agentAccountIds?: Set<string>
  /** MCP IDs the agent currently has access to. Omit for global views. */
  agentMcpIds?: Set<string>
  /** Optional optimistic overrides keyed by row.key. */
  grantOverrides?: Record<string, boolean>
}

interface ForeignRowsArgs {
  accounts?: ForeignAgentConnectedAccount[]
  mcps?: ForeignAgentRemoteMcp[]
}

/** Build noninteractive client-only rows for links owned by another member. */
export function buildForeignConnectionRows({
  accounts = [],
  mcps = [],
}: ForeignRowsArgs): UnifiedRow[] {
  const rows: UnifiedRow[] = accounts.map((account, index) => {
    const provider = getProvider(account.toolkitSlug)
    const id = `foreign-account-${account.toolkitSlug}-${index}`
    return {
      key: id,
      id,
      name: provider?.displayName ?? account.toolkitSlug,
      subtitle: 'Connected by another member',
      iconSlug: account.toolkitSlug,
      iconFallback: 'oauth',
      type: 'oauth',
      granted: true,
      foreign: true,
    }
  })

  mcps.forEach((_mcp, index) => {
    const id = `foreign-mcp-${index}`
    rows.push({
      key: id,
      id,
      name: 'Shared MCP connection',
      subtitle: 'Connected by another member',
      iconFallback: 'blocks',
      type: 'mcp',
      granted: true,
      foreign: true,
    })
  })

  return rows
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
  foreignAccounts = [],
  foreignMcps = [],
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

  out.push(...buildForeignConnectionRows({
    accounts: foreignAccounts,
    mcps: foreignMcps,
  }))

  return out.sort(
    (a, b) => {
      if (a.date === undefined) return b.date === undefined ? 0 : 1
      if (b.date === undefined) return -1
      return safeDate(b.date).getTime() - safeDate(a.date).getTime()
    },
  )
}
