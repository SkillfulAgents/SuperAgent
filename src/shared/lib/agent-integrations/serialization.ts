import type { ChatIntegration } from '../db/schema'
import { toPublicChatIntegration } from '../chat-integrations/public'
import type { PublicAgentIntegration } from './public'

/** All API routes serialize through this boundary; each family selects safe settings. */
export function toPublicAgentIntegration(row: ChatIntegration): PublicAgentIntegration {
  return toPublicChatIntegration(row)
}
