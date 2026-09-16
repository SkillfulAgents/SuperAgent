import type { ChatIntegration } from '../db/schema'
import { toPublicChatIntegration } from '../chat-integrations/public'
import { publicLinearIntegration } from '../task-manager-integrations/linear/setup'
import type { PublicAgentIntegration } from './public'
import type { PublicLinearIntegration } from '../task-manager-integrations/linear/public'

export function toPublicAgentIntegration(row: ChatIntegration): PublicAgentIntegration {
  if (row.provider !== 'linear') return { ...toPublicChatIntegration(row),
    capabilities: ['reset_conversation', 'session_timeout', 'tool_activity'], managementAccess: 'user' }
  const { config: _config, ...fields } = row
  const linear = publicLinearIntegration(row.id)
  const result: PublicLinearIntegration = { ...fields, provider: 'linear', hasCredentials: linear.authorized, settings: { runOnStatusChange: linear.runOnStatusChange },
    capabilities: [], managementAccess: 'owner', reconnectRequired: linear.authorizationState === 'reconnect_needed', linear }
  return result
}
