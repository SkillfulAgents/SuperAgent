import type { AgentIntegrationRecord, IntegrationRoute, IntegrationSessionContext } from '../agent-integrations/types'

export const taskManagerPolicy = {
  async isAllowed(context: IntegrationSessionContext): Promise<boolean> { return context.integration.status === 'active' || context.integration.status === 'error' },
  sessionPolicy(integration: AgentIntegrationRecord, route: Partial<IntegrationRoute>) {
    return { timeoutHours: null, name: route.displayName ?? `${integration.name ?? integration.provider}: ${route.externalId}`,
      metadata: { agentIntegrationId: integration.id, externalTaskId: route.externalId, isTaskIntegrationSession: true } }
  },
}
