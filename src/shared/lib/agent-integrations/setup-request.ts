import { agentRegistry } from '@shared/lib/agent-actor'
import { captureException } from '@shared/lib/error-reporting'
import { formatProviderName } from './presentation'
import type { AgentIntegrationRecord } from './types'

/**
 * An integration connected: every setup of that provider its agent handed to
 * the user (request_integration_setup) goes on with it. Runs on each connect,
 * so reconnecting an account the agent already had answers the ask too; that
 * is the account it was missing.
 */
export async function answerSetupRequests(integration: AgentIntegrationRecord): Promise<void> {
  const inputs = agentRegistry.get(integration.agentSlug).inputs
  const value = `${formatProviderName(integration.provider)} is set up (integration ID: ${integration.id}). Call list_agent_integrations for its identity, instructions and tools.`
  try {
    const open = (await inputs.snapshot())
      .filter(request => request.kind === 'integration_setup' && request.payload.provider === integration.provider)
    for (const request of open) await inputs.answer(request.id, value)
  } catch (error) {
    captureException(error, { tags: { component: 'agent-integration', operation: 'answer-setup-requests' }, extra: { integrationId: integration.id } })
  }
}
