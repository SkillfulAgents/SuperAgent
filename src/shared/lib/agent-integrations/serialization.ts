import type { AgentIntegrationRecord, IntegrationStatus } from './types'
import type { PublicAgentIntegration } from './public'
import { agentIntegrationRegistry } from './registry'

/** Preserve saved intent for a provider restored by a later app version, while
 * exposing unavailable installations as settled errors to UI and agent discovery. */
export function publicIntegrationStatus(row: Pick<AgentIntegrationRecord, 'provider' | 'status'>): IntegrationStatus {
  return row.status === 'active' && !agentIntegrationRegistry.getDefinition(row.provider) ? 'error' : row.status
}

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
      status: publicIntegrationStatus(row), llmProviderId: row.llmProviderId, model: row.model, effort: row.effort, speed: row.speed,
      createdByUserId: row.createdByUserId, createdAt: row.createdAt, updatedAt: row.updatedAt,
      hasCredentials: false, settings: {}, capabilities, managementAccess,
      errorMessage: definition
        ? 'Stored integration settings are invalid. Delete this integration and add it again.'
        : 'This integration provider is unavailable in this version of the app.' }
  }
}
