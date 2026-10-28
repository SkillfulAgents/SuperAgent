import { IntegrationMessage } from '@renderer/components/agent-integrations/messages/integration-message'
import type { UserMessageKindSpec } from './types'

/**
 * A message an integration (Slack, Linear, …) delivered. Recognised only by
 * the card data the host stored beside the transcript, never by its text, and
 * drawn as the provider's own preview instead of the model-facing context.
 */
export const integrationMessage: UserMessageKindSpec = {
  kind: 'integration',
  match: () => false,
  matchMessage: (message) => !!message.integration,
  hidden: false,
  Render: IntegrationMessage,
  chrome: 'bare',
}
