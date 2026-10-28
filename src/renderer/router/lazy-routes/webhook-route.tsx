import { useParams } from '@tanstack/react-router'
import { WebhookTriggerView } from '@renderer/components/webhook-triggers/webhook-trigger-view'
import { useAgentSlug } from './use-agent-slug'

export function WebhookRoute() {
  const slug = useAgentSlug()
  const { webhookId } = useParams({ strict: false }) as { webhookId?: string }
  if (!slug || !webhookId) return null
  return <WebhookTriggerView triggerId={webhookId} agentSlug={slug} />
}
