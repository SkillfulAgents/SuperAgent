import { getIntegration } from './store'
import { listChatIntegrations } from '../services/chat-integration-service'
import { agentIntegrationRegistry } from './registry'
import type { IntegrationMcpConnection } from './mcp-types'
import type { RemoteMcpRuntimeConfig } from '../container/connection-runtime-projections'

export const INTEGRATION_MCP_PREFIX = 'integration:'
export function integrationMcpName(id: string): string { return `agent_integration_${id.replace(/[^a-zA-Z0-9_]/g, '_')}` }

export async function resolveIntegrationMcp(agentSlug: string, connectionId: string): Promise<IntegrationMcpConnection | null> {
  if (!connectionId.startsWith(INTEGRATION_MCP_PREFIX)) return null
  const record = await getIntegration(connectionId.slice(INTEGRATION_MCP_PREFIX.length))
  if (!record || record.agentSlug !== agentSlug || record.status === 'paused') return null
  return agentIntegrationRegistry.getMcpConnection(record)
}

export async function integrationMcpProjection(agentSlug: string, hostApiBaseUrl: string): Promise<RemoteMcpRuntimeConfig[]> {
  const rows = await listChatIntegrations(agentSlug)
  const result: RemoteMcpRuntimeConfig[] = []
  for (const row of rows) {
    if (row.status === 'paused') continue
    try {
      const connection = await agentIntegrationRegistry.getMcpConnection(row)
      if (!connection) continue
      const id = `${INTEGRATION_MCP_PREFIX}${row.id}`
      result.push({ id, name: integrationMcpName(row.id), status: connection.status,
        proxyUrl: `${hostApiBaseUrl}/api/mcp-proxy/${agentSlug}/${id}`,
        tools: connection.tools.map(({ name }) => ({ name })),
        integration: { id: row.id, ...connection.identity },
      })
    } catch { /* A damaged installation cannot hide healthy connections. */ }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id))
}
