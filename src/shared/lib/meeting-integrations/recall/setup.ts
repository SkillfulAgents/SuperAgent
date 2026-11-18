import type { IntegrationProviderSetup } from '../../agent-integrations/setup-types'
import { recallConfigSchema } from './config'

/**
 * Nothing to verify at setup: credentials live with the platform (or the
 * host), not the installation. Whether the deployment can run meeting bots at
 * all is the provider's `isAvailable`, which setup checks before this runs.
 * With no credential to hand over, the agent may set itself up on first use
 * (the x-agent meetings route does, when asked to join a call).
 */
export const recallSetup: IntegrationProviderSetup = {
  allowAgentCreation: true,
  async prepare(input) {
    return { config: recallConfigSchema.parse(input ?? {}) }
  },
}
