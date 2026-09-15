import type { IntegrationProvider } from '../agent-integrations/registry'
import { taskManagerPolicy } from './policy'
import { linearDefinition } from './linear/definition'

export const taskManagerProviders: IntegrationProvider[] = [{
  definition: linearDefinition, policy: taskManagerPolicy,
  async cleanup(record) {
    const { cleanupLinearIntegration } = await import('./linear/setup')
    await cleanupLinearIntegration(record.id)
  },
  async create(record) {
    const { LinearAgentIntegration } = await import('./linear/linear-agent-integration')
    return new LinearAgentIntegration(record)
  },
}]
