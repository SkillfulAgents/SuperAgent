import { INTEGRATION_MCP_PREFIX, resolveIntegrationMcp } from '../agent-integrations/mcp'
import { resolveAccountMcpConnection } from './account-connection'
import { IntegrationMcpAdapter } from './integration-connection'
import type { McpConnection } from './connection-types'

export type McpConnectionResolution =
  | { ok: true; connection: McpConnection }
  | { ok: false; reason: 'unavailable' | 'not_assigned' }

/** Source selection happens once. Transport consumers only see McpConnection. */
export async function resolveMcpConnection(agentSlug: string, id: string): Promise<McpConnectionResolution> {
  if (id.startsWith(INTEGRATION_MCP_PREFIX)) {
    const provider = await resolveIntegrationMcp(agentSlug, id)
    if (!provider) return { ok: false, reason: 'unavailable' }
    return { ok: true, connection: new IntegrationMcpAdapter(id, provider) }
  }
  const connection = await resolveAccountMcpConnection(agentSlug, id)
  return connection ? { ok: true, connection } : { ok: false, reason: 'not_assigned' }
}
