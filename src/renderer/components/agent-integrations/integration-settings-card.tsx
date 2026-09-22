import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { integrationSetupProviders } from './setup-providers'

export function IntegrationSettingsCard(props: { integration: PublicAgentIntegration; canManageAccess?: boolean }) {
  const Settings = integrationSetupProviders.find(provider => provider.slug === props.integration.provider)?.Settings
  return Settings ? <Settings {...props} /> : null
}
