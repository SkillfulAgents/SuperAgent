import type { AgentIntegrationDefinition } from '../agent-integrations/types'
import type { ChatProvider } from './config-schema'

const chat = { managementCapabilities: ['reset_conversation', 'session_timeout', 'tool_activity'] as const, family: 'chat', managementAccess: 'user' as const, settings: [{ key: 'showToolCalls', label: 'Show tool calls', type: 'boolean' as const }] }
export const chatDefinitions: Record<ChatProvider, AgentIntegrationDefinition> = {
  telegram: { ...chat, provider: 'telegram', name: 'Telegram', capabilities: ['send_message'], setup: { kind: 'bot-token', credentialFields: ['botToken'] },
    // Long polling, or the bot's webhook when the host has a relay.
    transports: ['direct', 'relay'] },
  slack: { ...chat, provider: 'slack', name: 'Slack', capabilities: ['send_message', 'list_users', 'list_channels', 'dm_by_user_id'], setup: { kind: 'slack-app', credentialFields: ['botToken', 'appToken', 'signingSecret'] },
    // Socket Mode, or the app's request URLs once its webhooks are set up and verify.
    transports: ['direct', 'relay'] },
  imessage: { ...chat, provider: 'imessage', name: 'iMessage', capabilities: ['send_message'], setup: { kind: 'imessage-gateway', credentialFields: ['gatewayUrl', 'token'] },
    // Live traffic stays on the socket; the relay carries what arrives while it's down.
    transports: ['direct', 'relay'] },
}
