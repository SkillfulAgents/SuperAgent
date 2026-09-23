import type { AgentIntegrationRecord, IntegrationRoute } from '../agent-integrations/types'

export const emailDefinition = {
  provider: 'platform-email', name: 'Email', family: 'email', managementAccess: 'owner', managementCapabilities: [], capabilities: ['send_email', 'list_users', 'list_channels'], settings: [],
  agentInstructions: 'Use send_chat_message with message as the email body and email: {to: ["recipient@example.com"], subject: "Subject", idempotency_key: "unique-send-key"}. Never use user_id or chat_id for Email. If the recipient address is unknown, call list_chat_users; otherwise send directly. list_chat_channels is only for finding an existing email thread to reply to (email.reply_to_message_id), not for starting a new email. No existing session or conversation is required. Reuse the same key and identical content on retries; queued means accepted, not delivered. Inbox setup is owner-managed in the app, not through Gmail/Outlook OAuth.',
  setup: { kind: 'platform-email', credentialFields: [] },
} as const
export const emailSessionPolicy = (integration: AgentIntegrationRecord, route: Partial<IntegrationRoute>) => ({
  timeoutHours: null, name: route.displayName || integration.name || 'Email conversation',
  metadata: { isChatIntegrationSession: true, chatIntegrationId: integration.id },
})
