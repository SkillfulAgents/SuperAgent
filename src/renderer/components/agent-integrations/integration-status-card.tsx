import { Switch } from '@renderer/components/ui/switch'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { useUpdateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { deriveAgentIntegrationState } from '@shared/lib/agent-integrations/presentation'
import { AgentIntegrationPill } from './agent-integration-pill'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'

export function IntegrationStatusCard({ integration, connected }: {
  integration: PublicAgentIntegration
  connected?: boolean
}) {
  const updateIntegration = useUpdateAgentIntegration()
  const state = deriveAgentIntegrationState(integration.status, connected, integration.reconnectRequired)
  // "On" covers active/error/connecting — anything the user means to be running.
  const isOn = integration.status !== 'paused' && integration.status !== 'disconnected'

  return (
    <DetailCard
      label="Status"
      headerActions={
        <div className="flex items-center gap-2">
          <AgentIntegrationPill state={state} />
          <Switch
            className="scale-75 origin-right"
            checked={isOn}
            disabled={updateIntegration.isPending || (!isOn && !integration.hasCredentials)}
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
