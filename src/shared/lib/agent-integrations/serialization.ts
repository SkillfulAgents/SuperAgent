import type { AgentIntegrationRecord } from './types'
import type { PublicAgentIntegration, IntegrationCapability } from './public'
import { agentIntegrationRegistry } from './registry'

const presentationCapabilities: readonly IntegrationCapability[] = ['reset_conversation', 'session_timeout', 'tool_activity']

/** The provider selects its safe settings; management policy comes from the
 * same definition used to authorize writes, never from a client-supplied flag. */
export function toPublicAgentIntegration(row: AgentIntegrationRecord): PublicAgentIntegration {
  const provider = agentIntegrationRegistry.getProvider(row.provider)
  const capabilities = presentationCapabilities.filter(capability => provider.definition.capabilities.includes(capability))
  const managementAccess = provider.definition.managementAccess ?? 'owner'
  try {
    if (!provider.serialize) throw new Error('Integration serialization unavailable')
    return { ...provider.serialize(row), capabilities, managementAccess }
  } catch {
    return { id: row.id, agentSlug: row.agentSlug, provider: row.provider, name: row.name,
      status: row.status, model: row.model, effort: row.effort, speed: row.speed,
      createdByUserId: row.createdByUserId, createdAt: row.createdAt, updatedAt: row.updatedAt,
      hasCredentials: false, settings: {}, capabilities, managementAccess,
      errorMessage: 'Stored integration settings are invalid. Delete this integration and add it again.' }
  }
}
