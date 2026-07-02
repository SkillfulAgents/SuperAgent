import { Switch } from '@renderer/components/ui/switch'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { useUpdateChatIntegration } from '@renderer/hooks/use-chat-integrations'
import { deriveChatIntegrationState } from '@shared/lib/chat-integrations/utils'
import { ChatIntegrationPill } from './chat-integration-pill'
import type { ChatIntegration } from '@shared/lib/db/schema'

export function IntegrationStatusCard({ integration, connected }: {
  integration: ChatIntegration
  connected?: boolean
}) {
  const updateIntegration = useUpdateChatIntegration()
  const state = deriveChatIntegrationState(integration.status, connected)
  // "On" covers active/error/connecting — anything the user means to be running.
  const isOn = integration.status !== 'paused'

  return (
    <DetailCard
      label="Status"
      headerActions={
        <div className="flex items-center gap-2">
          <ChatIntegrationPill state={state} />
          <Switch
            className="scale-75 origin-right"
            checked={isOn}
            disabled={updateIntegration.isPending}
            aria-label={isOn ? 'Pause integration' : 'Resume integration'}
            onCheckedChange={(next) =>
              updateIntegration.mutate({ id: integration.id, status: next ? 'active' : 'paused' })
            }
          />
        </div>
      }
    />
  )
}
