import { listAgentIntegrations } from '../services/agent-integration-service'
import { captureException } from '../error-reporting'
import { agentIntegrationRegistry } from './registry'
import { agentIntegrationManager } from './agent-integration-manager'
import type { AgentIntegrationRecord } from './types'

/** Stop the local runtime before deletion; unavailable remote services cannot block it. */
export async function cleanupIntegrationResource(integration: AgentIntegrationRecord): Promise<void> {
  await agentIntegrationManager.pauseIntegration(integration.id)
  try {
    await agentIntegrationRegistry.cleanup(integration)
  } catch (error) {
    captureException(error, {
      tags: { component: 'agent-integration', operation: 'cleanup' },
      extra: { integrationId: integration.id, provider: integration.provider },
    })
  }
}

export async function cleanupIntegrationResources(agentSlug?: string): Promise<void> {
  const failures: unknown[] = []
  for (const integration of await listAgentIntegrations(agentSlug)) {
    try { await cleanupIntegrationResource(integration) } catch (error) { failures.push(error) }
  }
  // Do not delete credentials while a local runtime might still be using them.
  if (failures.length) throw new AggregateError(failures, 'Failed to stop integration runtimes')
}
