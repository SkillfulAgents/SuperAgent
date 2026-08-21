import { IntegrationStatusCard } from './integration-status-card'
import { IntegrationSettingsCard } from './integration-settings-card'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { IntegrationModelEffort } from './integration-settings-controls'
import type { PublicChatIntegration as ChatIntegration } from '@shared/lib/chat-integrations/public'

export interface ChatIntegrationSidePanelProps {
  integration: ChatIntegration
  canManage: boolean
  /** Telegram owner: can gate new conversations behind approval. */
  canManageAccess: boolean
  /** Live connection state from the integration status poll. */
  connected?: boolean
}

export function ChatIntegrationSidePanel({ integration, canManage, canManageAccess, connected }: ChatIntegrationSidePanelProps) {
  return (
    <div className="space-y-3">
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
