import { tool } from '@anthropic-ai/claude-agent-sdk'
import { callChatHost, textResult, XAgentError } from './host-client'

interface ChatSession {
  chatId: string
  displayName: string | null
  type?: string
}

interface ChatIntegrationInfo {
  id: string
  provider: string
  name: string | null
  status: string
  capabilities?: string[]
  chats: ChatSession[]
}

interface ListResult {
  integrations: ChatIntegrationInfo[]
}

export const listChatIntegrationsTool = tool(
  'list_chat_integrations',
  `List chat integrations configured for this agent. Returns each integration's ID, provider, status, discovery capabilities, and active chat sessions with their chat IDs and conversation type (dm/channel/group/thread).

Use the integration ID and chat ID when calling send_chat_message. Integrations whose capabilities include list_users / list_channels / dm_by_user_id also support the list_chat_users and list_chat_channels tools and send_chat_message's user_id parameter — use those to reach people or channels with no existing chat.`,
  {},
  async () => {
    try {
      const data = await callChatHost<ListResult>('list', {})
      if (data.integrations.length === 0) {
        return textResult('No chat integrations configured for this agent. Use list_available_chat_providers to see what can be set up, then add_chat_integration to create one.')
      }
      const lines = data.integrations.map((i) => {
        const name = i.name ? ` "${i.name}"` : ''
        const capabilities = i.capabilities?.length ? ` — capabilities: ${i.capabilities.join(', ')}` : ''
        const chatLines = i.chats.length > 0
          ? i.chats.map((c) => `    - chatId: ${c.chatId}${c.displayName ? ` (${c.displayName})` : ''}${c.type ? ` [${c.type}]` : ''}`).join('\n')
          : '    (no active chats yet)'
        return `- ${i.provider}${name} [${i.status}] (id: ${i.id})${capabilities}\n${chatLines}`
      })
      return textResult(`Chat integrations (${data.integrations.length}):\n${lines.join('\n')}`)
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to list chat integrations: ${msg}`, true)
    }
  },
)
