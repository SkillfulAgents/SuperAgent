import { listAgentIntegrations } from '../services/agent-integration-service'
import { listActiveAgentIntegrationSessions } from '../services/agent-integration-session-service'
import { agentIntegrationRegistry } from './registry'
import { integrationMcpName } from './mcp'
import { publicIntegrationStatus } from './serialization'

/** Agent-scoped discovery, independent of provider family or a live connector.
 * Explicit projection keeps credentials and provider setup secrets off the wire. */
export async function listAgentIntegrationInventory(agentSlug: string) {
  return Promise.all((await listAgentIntegrations(agentSlug)).map(async row => {
    const definition = agentIntegrationRegistry.getDefinition(row.provider)
    const sessions = await agentIntegrationRegistry.conversations(row, await listActiveAgentIntegrationSessions(row.id), { threads: true })
    let mcp = null
    try {
      const connection = row.status === 'paused' ? null : await agentIntegrationRegistry.getMcpConnection(row)
      if (connection) mcp = { name: integrationMcpName(row.id), status: connection.status, identity: connection.identity, tools: connection.tools.map(tool => tool.name) }
    } catch { /* A damaged connection remains listed and cannot hide healthy accounts. */ }
    const { address } = agentIntegrationRegistry.agentDiscovery(row)
    return { id: row.id, provider: row.provider, family: definition?.family ?? 'unknown', name: row.name, status: publicIntegrationStatus(row),
      capabilities: [...(definition?.capabilities ?? [])], sessions, mcp,
      ...(address ? { address } : {}),
      ...(definition?.agentInstructions ? { instructions: definition.agentInstructions } : {}) }
  }))
}
