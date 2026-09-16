import type { PublicAgentIntegration } from '../../agent-integrations/public'
import type { publicLinearIntegration } from './setup'

export type PublicLinearIntegration = PublicAgentIntegration<{ runOnStatusChange: boolean }> & {
  provider: 'linear'
  linear: ReturnType<typeof publicLinearIntegration>
}

/** Narrow an already-serialized integration to Linear's public settings. */
export function isPublicLinearIntegration(integration: PublicAgentIntegration): integration is PublicLinearIntegration {
  return integration.provider === 'linear' && 'linear' in integration && integration.linear != null
}
