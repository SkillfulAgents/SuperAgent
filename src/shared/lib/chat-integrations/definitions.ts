import type { AgentIntegrationDefinition } from '../agent-integrations/types'
import type { ChatProvider } from './config-schema'

const chat = { family: 'chat', managementAccess: 'user' as const, settings: [{ key: 'showToolCalls', label: 'Show tool calls', type: 'boolean' as const }] }
export const chatDefinitions: Record<ChatProvider, AgentIntegrationDefinition> = {
  telegram: { ...chat, provider: 'telegram', name: 'Telegram', capabilities: ['reset_conversation', 'session_timeout', 'tool_activity', 'send_message'], setup: { kind: 'bot-token', credentialFields: ['botToken'] } },
  slack: { ...chat, provider: 'slack', name: 'Slack', capabilities: ['reset_conversation', 'session_timeout', 'tool_activity', 'send_message', 'list_users', 'list_channels', 'dm_by_user_id'], setup: { kind: 'slack-app', credentialFields: ['botToken', 'appToken'] } },
  imessage: { ...chat, provider: 'imessage', name: 'iMessage', capabilities: ['reset_conversation', 'session_timeout', 'tool_activity', 'send_message'], setup: { kind: 'imessage-gateway', credentialFields: ['gatewayUrl', 'token'] } },
}
