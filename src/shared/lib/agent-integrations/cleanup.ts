import { listChatIntegrations } from '../services/chat-integration-service'
import { agentIntegrationRegistry } from './registry'

/** Tear down provider-owned resources before their local credentials are removed. */
export async function cleanupIntegrationResources(agentSlug?: string): Promise<void> {
  for (const integration of listChatIntegrations(agentSlug)) {
    await agentIntegrationRegistry.cleanup(integration)
  }
}
