import { integrationSetupProviders } from './setup-providers'
import { IntegrationStatusCard } from './integration-status-card'
import { IntegrationSettingsCard } from './integration-settings-card'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { IntegrationModelEffort } from './integration-settings-controls'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'

export interface AgentIntegrationSidePanelProps {
  integration: PublicAgentIntegration
  canManage: boolean
  /** Telegram owner: can gate new conversations behind approval. */
  canManageAccess: boolean
  /** Live connection state from the integration status poll. */
  connected?: boolean
}

export function AgentIntegrationSidePanel({ integration, canManage, canManageAccess, connected }: AgentIntegrationSidePanelProps) {
  const ConnectionSettings = integrationSetupProviders.find(provider => provider.slug === integration.provider)?.ConnectionSettings
  return (
    <div className="space-y-3">
      {canManage && ConnectionSettings && <ConnectionSettings integration={integration} />}
      {canManage && <IntegrationStatusCard integration={integration} connected={connected} />}
      {canManage && <IntegrationSettingsCard integration={integration} canManageAccess={canManageAccess} />}
      {canManage && (
        <DetailCard label="Model & Effort">
          <IntegrationModelEffort integration={integration} />
        </DetailCard>
      )}
    </div>
  )
}
