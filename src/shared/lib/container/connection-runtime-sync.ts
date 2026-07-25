import { db } from '@shared/lib/db'
import {
  agentConnectedAccounts,
  agentRemoteMcps,
  connectedAccounts,
  remoteMcpServers,
} from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'
import { containerManager } from './container-manager'

type RuntimeClient = Pick<
  ReturnType<typeof containerManager.getClient>,
  'fetch' | 'getHostApiBaseUrl'
>

export type ConnectionRuntimeKind = 'connected-accounts' | 'remote-mcps'

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

export async function updateConnectedAccountsEnvironment(
  agentSlug: string,
  client: RuntimeClient,
): Promise<Response> {
  const mappings = await db
    .select({ account: connectedAccounts })
    .from(agentConnectedAccounts)
    .innerJoin(
      connectedAccounts,
      eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id),
    )
    .where(eq(agentConnectedAccounts.agentSlug, agentSlug))

  const metadata: Record<string, Array<{ name: string; id: string }>> = {}
  const activeAccounts = mappings
    .map(({ account }) => account)
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

  return client.fetch('/env', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: 'CONNECTED_ACCOUNTS',
      value: JSON.stringify(metadata),
    }),
  })
}

export async function updateRemoteMcpEnvironment(
  agentSlug: string,
  client: RuntimeClient,
): Promise<Response> {
  const hostApiBaseUrl = await client.getHostApiBaseUrl()
  const mappings = await db
    .select({ mcp: remoteMcpServers })
    .from(agentRemoteMcps)
    .innerJoin(
      remoteMcpServers,
      eq(agentRemoteMcps.remoteMcpId, remoteMcpServers.id),
    )
    .where(eq(agentRemoteMcps.agentSlug, agentSlug))

  const configs = mappings
    .map(({ mcp }) => mcp)
    .filter((mcp) => mcp.status === 'active')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((mcp) => ({
      id: mcp.id,
      name: mcp.name,
      proxyUrl: `${hostApiBaseUrl}/api/mcp-proxy/${agentSlug}/${mcp.id}`,
      tools: parseToolNames(mcp.toolsJson),
    }))

  return client.fetch('/env', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: 'REMOTE_MCPS',
      value: JSON.stringify(configs),
    }),
  })
}

export async function syncAgentConnectionEnvironment(
  agentSlug: string,
  kind: ConnectionRuntimeKind,
): Promise<boolean> {
  if (containerManager.getCachedInfo(agentSlug).status !== 'running') {
    // Container startup rebuilds both projections from the mapping tables.
    return true
  }

  try {
    const client = containerManager.getClient(agentSlug)
    const response = kind === 'remote-mcps'
      ? await updateRemoteMcpEnvironment(agentSlug, client)
      : await updateConnectedAccountsEnvironment(agentSlug, client)

    if (!response.ok) {
      console.warn(
        `[ConnectionRuntimeSync] Failed to update ${kind} for ${agentSlug}:`,
        await response.text(),
      )
    }
    return response.ok
  } catch (error) {
    console.warn(
      `[ConnectionRuntimeSync] Failed to sync ${kind} for ${agentSlug}:`,
      error,
    )
    return false
  }
}

async function syncAgents(
  agentSlugs: string[],
  kind: ConnectionRuntimeKind,
): Promise<boolean> {
  const results = await Promise.all(
    [...new Set(agentSlugs)].map((slug) =>
      syncAgentConnectionEnvironment(slug, kind),
    ),
  )
  return results.every(Boolean)
}

export async function findAgentsAssignedRemoteMcp(mcpId: string): Promise<string[]> {
  const mappings = await db
    .select({ agentSlug: agentRemoteMcps.agentSlug })
    .from(agentRemoteMcps)
    .where(eq(agentRemoteMcps.remoteMcpId, mcpId))
  return mappings.map(({ agentSlug }) => agentSlug)
}

export async function findAgentsAssignedConnectedAccount(
  accountId: string,
): Promise<string[]> {
  const mappings = await db
    .select({ agentSlug: agentConnectedAccounts.agentSlug })
    .from(agentConnectedAccounts)
    .where(eq(agentConnectedAccounts.connectedAccountId, accountId))
  return mappings.map(({ agentSlug }) => agentSlug)
}

export async function syncRemoteMcpAgents(agentSlugs: string[]): Promise<boolean> {
  return syncAgents(agentSlugs, 'remote-mcps')
}

export async function syncConnectedAccountAgents(
  agentSlugs: string[],
): Promise<boolean> {
  return syncAgents(agentSlugs, 'connected-accounts')
}

export async function syncAgentsAssignedRemoteMcp(mcpId: string): Promise<boolean> {
  try {
    return syncRemoteMcpAgents(await findAgentsAssignedRemoteMcp(mcpId))
  } catch (error) {
    console.warn(
      `[ConnectionRuntimeSync] Failed to resolve agents assigned MCP ${mcpId}:`,
      error,
    )
    return false
  }
}

export async function syncAgentsAssignedConnectedAccount(
  accountId: string,
): Promise<boolean> {
  try {
    return syncConnectedAccountAgents(
      await findAgentsAssignedConnectedAccount(accountId),
    )
  } catch (error) {
    console.warn(
      `[ConnectionRuntimeSync] Failed to resolve agents assigned account ${accountId}:`,
      error,
    )
    return false
  }
}
