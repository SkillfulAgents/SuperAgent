import type { AgentIntegrationRecord } from './types'
import type { PublicAgentIntegration } from './public'
import { agentIntegrationRegistry } from './registry'

/** The provider selects its safe settings; management policy comes from the
 * same definition used to authorize writes, never from a client-supplied flag. */
export function toPublicAgentIntegration(row: AgentIntegrationRecord): PublicAgentIntegration {
  const definition = agentIntegrationRegistry.getDefinition(row.provider)
  const capabilities = definition?.managementCapabilities ?? []
  const managementAccess = definition?.managementAccess ?? 'owner'
  try {
    const provider = agentIntegrationRegistry.getProvider(row.provider)
    if (!provider.serialize) throw new Error('Integration serialization unavailable')
    return { ...provider.serialize(row), capabilities, managementAccess }
  } catch {
    return { id: row.id, agentSlug: row.agentSlug, provider: row.provider, name: row.name,
      status: row.status, model: row.model, effort: row.effort, speed: row.speed,
      createdByUserId: row.createdByUserId, createdAt: row.createdAt, updatedAt: row.updatedAt,
      hasCredentials: false, settings: {}, capabilities, managementAccess,
      errorMessage: definition
        ? 'Stored integration settings are invalid. Delete this integration and add it again.'
        : 'This integration provider is unavailable in this version of the app.' }
  }
}
