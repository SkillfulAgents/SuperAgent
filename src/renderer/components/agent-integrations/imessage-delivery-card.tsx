import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { DeliveryCard } from './delivery-card'

/** How iMessage reaches this agent: webhooks with a relay, a live connection to the iMessage gateway otherwise. */
export function IMessageDeliveryCard({ integration }: { integration: PublicAgentIntegration }) {
  return <DeliveryCard
    integration={integration}
    relay="Through webhooks. Messages sent while this agent is offline are delivered when it’s back."
    direct="Over a live connection to the iMessage gateway. The gateway holds messages sent while it’s disconnected for up to 24 hours."
  />
}
