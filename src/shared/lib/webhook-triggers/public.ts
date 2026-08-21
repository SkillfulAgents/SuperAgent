import type { WebhookTrigger } from '@shared/lib/db/schema'
import type { AgentRole } from '@shared/lib/types/agent'

type OwnerOnlyWebhookTriggerFields = Pick<
  WebhookTrigger,
  'triggerConfig' | 'composioTriggerId' | 'connectedAccountId' | 'createdByUserId'
>

/**
 * Webhook trigger fields safe for every agent member. Capability-bearing
 * configuration and owner metadata are present only in owner responses.
 */
export type PublicWebhookTrigger = Omit<WebhookTrigger, keyof OwnerOnlyWebhookTriggerFields>
  & Partial<OwnerOnlyWebhookTriggerFields>

/**
 * Convert the internal DB row into the role-aware API contract. A missing role
 * is treated as unprivileged so a route cannot expose capabilities merely by
 * forgetting to attach authorization context.
 */
export function toPublicWebhookTrigger(
  trigger: WebhookTrigger,
  role: AgentRole | null,
): PublicWebhookTrigger {
  if (role === 'owner') return { ...trigger }

  const {
    triggerConfig: _triggerConfig,
    composioTriggerId: _composioTriggerId,
    connectedAccountId: _connectedAccountId,
    createdByUserId: _createdByUserId,
    ...publicFields
  } = trigger

  return publicFields
}
