import { eq } from 'drizzle-orm'
import { db } from '../db'
import { agentConnectedAccounts, agentRemoteMcps, connectedAccounts, remoteMcpServers } from '../db/schema'
import { getDefaultAccountProvider } from '../account-providers/provider-factory'
import { getAgentOfferedProviders } from '../account-providers/service-catalog'
import { isPlatformComposioActive } from '../composio/client'
import { COMMON_MCP_SERVERS } from '../mcp/common-servers'
import { sameMcpEndpoint } from '../mcp/endpoint'
import { listAgentIntegrationProviders } from '../agent-integrations/agent-provider-listing'
import { agentIntegrationRegistry } from '../agent-integrations/registry'
import { listAgentIntegrations } from '../services/agent-integration-service'
import { buildConnectionCatalog, type ConnectionService } from './catalog'

/** The first status that isn't `active`, unless one is. */
function closestToActive(statuses: string[]): string {
  return statuses.includes('active') ? 'active' : statuses[0]
}

function groupStatuses(rows: Array<{ key: string; status: string }>): Map<string, string> {
  const byKey = new Map<string, string[]>()
  for (const { key, status } of rows) byKey.set(key, [...byKey.get(key) ?? [], status])
  return new Map([...byKey].map(([key, statuses]) => [key, closestToActive(statuses)]))
}

/** Every service this host offers the agent, marked with what the agent already has. */
export async function agentConnectionCatalog(agentSlug: string): Promise<ConnectionService[]> {
  const [accountProvider, platformComposio, integrationListing, accountRows, mcpRows, installations] = await Promise.all([
    getDefaultAccountProvider(),
    isPlatformComposioActive(),
    listAgentIntegrationProviders(),
    db.select({ toolkit: connectedAccounts.toolkitSlug, status: connectedAccounts.status })
      .from(agentConnectedAccounts)
      .innerJoin(connectedAccounts, eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id))
      .where(eq(agentConnectedAccounts.agentSlug, agentSlug)),
    db.select({ url: remoteMcpServers.url, status: remoteMcpServers.status })
      .from(agentRemoteMcps)
      .innerJoin(remoteMcpServers, eq(agentRemoteMcps.remoteMcpId, remoteMcpServers.id))
      .where(eq(agentRemoteMcps.agentSlug, agentSlug)),
    listAgentIntegrations(agentSlug),
  ])

  // The runtime projection keeps exactly these: anything else is not assigned.
  const assignedAccounts = groupStatuses(accountRows
    .filter(({ status }) => status === 'active' || status === 'expired' || status === 'revoked')
    .map(({ toolkit, status }) => ({ key: toolkit, status })))
  const assignedIntegrations = groupStatuses(installations.map(({ provider, status }) => ({ key: provider, status })))

  return buildConnectionCatalog({
    accounts: getAgentOfferedProviders(accountProvider.name, platformComposio).map((provider) => ({
      toolkit: provider.slug,
      displayName: provider.displayName,
      description: provider.description,
      category: provider.category,
      ...(assignedAccounts.has(provider.slug) ? { assigned: assignedAccounts.get(provider.slug) } : {}),
    })),
    mcps: COMMON_MCP_SERVERS.map((server) => {
      const statuses = mcpRows.filter((row) => sameMcpEndpoint(row.url, server.url)).map((row) => row.status)
      return {
        slug: server.slug,
        displayName: server.displayName,
        description: server.description,
        category: server.category,
        url: server.url,
        authType: server.authType,
        setupRequired: !!server.setup?.requiresClientId,
        ...(statuses.length > 0 ? { assigned: closestToActive(statuses) } : {}),
      }
    }),
    integrations: integrationListing.providers.map((listing) => ({
      ...listing,
      family: agentIntegrationRegistry.getDefinition(listing.provider)?.family ?? '',
      ...(assignedIntegrations.has(listing.provider) ? { assigned: assignedIntegrations.get(listing.provider) } : {}),
    })),
  })
}
