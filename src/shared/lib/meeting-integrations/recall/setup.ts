import type { IntegrationProviderSetup } from '../../agent-integrations/setup-types'
import { recallConfigSchema } from './config'

/**
 * Nothing to verify at setup: credentials live with the platform (or the
 * host), not the installation. Whether the deployment can run meeting bots at
 * all is the provider's `isAvailable`, which setup checks before this runs.
 */
export const recallSetup: IntegrationProviderSetup = {
  async prepare(input) {
    return { config: recallConfigSchema.parse(input ?? {}) }
  },
}
