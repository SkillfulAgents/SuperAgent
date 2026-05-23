import { tool } from '@anthropic-ai/claude-agent-sdk'
import { callChatHost, textResult, XAgentError } from './host-client'

interface ChatSession {
  chatId: string
  displayName: string | null
}

interface ChatIntegrationInfo {
  id: string
  provider: string
  name: string | null
  status: string
  chats: ChatSession[]
}

interface ListResult {
  integrations: ChatIntegrationInfo[]
}

export const listChatIntegrationsTool = tool(
  'list_chat_integrations',
  `List chat integrations configured for this agent. Returns each integration's ID, provider, status, and active chat sessions with their chat IDs.

Use the integration ID and chat ID when calling send_chat_message.`,
  {},
  async () => {
    try {
      const data = await callChatHost<ListResult>('list', {})
      if (data.integrations.length === 0) {
        return textResult('No chat integrations configured for this agent. Use list_available_chat_providers to see what can be set up, then add_chat_integration to create one.')
      }
      const lines = data.integrations.map((i) => {
        const name = i.name ? ` "${i.name}"` : ''
        const chatLines = i.chats.length > 0
          ? i.chats.map((c) => `    - chatId: ${c.chatId}${c.displayName ? ` (${c.displayName})` : ''}`).join('\n')
          : '    (no active chats yet)'
        return `- ${i.provider}${name} [${i.status}] (id: ${i.id})\n${chatLines}`
      })
      return textResult(`Chat integrations (${data.integrations.length}):\n${lines.join('\n')}`)
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to list chat integrations: ${msg}`, true)
    }
  },
)
