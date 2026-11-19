import { DetailCard } from '@renderer/components/triggers/detail-card'
import { useAgentIntegrationStatus } from '@renderer/hooks/use-agent-integrations'
import { useWebhookRelay } from '@renderer/hooks/use-webhook-relay'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'

/**
 * How a provider's events reach this agent, for providers that pick their path
 * each time they connect: webhooks whenever the host has a relay (set up
 * automatically), their own live connection otherwise.
 */
export function DeliveryCard({ integration, relay: throughRelay, direct }: { integration: PublicAgentIntegration; relay: string; direct: string }) {
  const { data: connection } = useAgentIntegrationStatus(integration.id)
  const { data: relay } = useWebhookRelay()
  // What the running connection uses; the next connect may differ.
  const running = connection?.transport ?? null
  return <DetailCard label="Event Delivery">
    <div className="space-y-2 text-sm">
      <p data-testid="delivery-path">{running === 'relay' ? throughRelay : running === 'direct' ? direct : 'Not connected.'}</p>
      {running === 'direct' && relay?.available && <p role="status" className="text-xs text-muted-foreground" data-testid="delivery-next">
        It switches to webhooks the next time it connects.
      </p>}
    </div>
  </DetailCard>
}
