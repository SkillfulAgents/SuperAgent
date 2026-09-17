import { listChatIntegrations } from '../services/chat-integration-service'
import { agentIntegrationRegistry } from './registry'
import { agentIntegrationManager } from './agent-integration-manager'

/** Tear down provider-owned resources before their local credentials are removed. */
export async function cleanupIntegrationResources(agentSlug?: string): Promise<void> {
  for (const integration of listChatIntegrations(agentSlug)) {
    await agentIntegrationManager.pauseIntegration(integration.id)
    await agentIntegrationRegistry.cleanup(integration)
  }
}
