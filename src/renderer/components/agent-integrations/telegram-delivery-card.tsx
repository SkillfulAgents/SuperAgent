import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { DeliveryCard } from './delivery-card'

/** How Telegram reaches this agent: the bot's webhook with a relay, long polling otherwise. */
export function TelegramDeliveryCard({ integration }: { integration: PublicAgentIntegration }) {
  return <DeliveryCard
    integration={integration}
    relay="Through webhooks. Messages sent while this agent is offline are delivered when it’s back."
    direct="By polling Telegram. Telegram holds messages sent while it’s disconnected for up to 24 hours."
  />
}
