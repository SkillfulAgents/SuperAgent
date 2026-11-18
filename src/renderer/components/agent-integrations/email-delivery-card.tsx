import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { DeliveryCard } from './delivery-card'

/** How new mail reaches this agent: webhooks with a relay, a live connection to the email gateway otherwise. */
export function EmailDeliveryCard({ integration }: { integration: PublicAgentIntegration }) {
  return <DeliveryCard
    integration={integration}
    relay="Through webhooks. Mail that arrives while this agent is offline is read when it’s back."
    direct="Over a live connection to the email gateway. Mail that arrives while it’s disconnected is read when it reconnects."
  />
}
