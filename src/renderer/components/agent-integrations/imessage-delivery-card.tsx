import { DetailCard } from '@renderer/components/triggers/detail-card'
import { useAgentIntegrationStatus } from '@renderer/hooks/use-agent-integrations'
import { useWebhookRelay } from '@renderer/hooks/use-webhook-relay'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'

/**
 * How iMessage reaches this agent. Chosen each time it connects: webhooks
 * whenever the host has a relay (set up automatically), a live connection to
 * the iMessage gateway otherwise.
 */
export function IMessageDeliveryCard({ integration }: { integration: PublicAgentIntegration }) {
  const { data: connection } = useAgentIntegrationStatus(integration.id)
  const { data: relay } = useWebhookRelay()
  // What the running connection uses; the next connect may differ.
  const running = connection?.transport ?? null
  return <DetailCard label="Event Delivery">
    <div className="space-y-2 text-sm">
      <p data-testid="imessage-delivery-path">{running === 'relay'
        ? 'Through webhooks. Messages sent while this agent is offline are delivered when it’s back.'
        : running === 'direct'
          ? 'Over a live connection to the iMessage gateway. The gateway holds messages sent while it’s disconnected for up to 24 hours.'
          : 'Not connected.'}</p>
      {running === 'direct' && relay?.available && <p role="status" className="text-xs text-muted-foreground" data-testid="imessage-delivery-next">
        It switches to webhooks the next time it connects.
      </p>}
    </div>
  </DetailCard>
}
