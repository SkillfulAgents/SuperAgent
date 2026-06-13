import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callChatHost, textResult, XAgentError } from './host-client'

interface SendResult {
  chatId: string
  provider: string
}

export const sendChatMessageTool = tool(
  'send_chat_message',
  `Send a message to a user through a chat integration (Telegram, Slack, or iMessage).

The message is delivered immediately to the external chat. It is also logged in the agent's session history so follow-up conversations have context.

The chat_id is optional when the integration has exactly one active chat. If there are multiple active chats, you must specify which one — use list_chat_integrations to see available chat IDs.

Use the optional context parameter to attach internal notes that help the agent understand the message's purpose on follow-up. Context is NOT sent to the user — it is only recorded in the session log.`,
  {
    integration_id: z.string().describe('ID of the chat integration to send through'),
    message: z.string().describe('The message text to send to the user'),
    chat_id: z.string().optional().describe('Target chat ID. Required if the integration has multiple active chats.'),
    context: z.string().optional().describe('Internal context for session continuity. Not sent to the user — only recorded in the session log.'),
  },
  async ({ integration_id, message, chat_id, context }) => {
    try {
      const data = await callChatHost<SendResult>('send', {
        integration_id,
        message,
        chat_id,
        context,
      })
      return textResult(`Message sent via ${data.provider} to chat ${data.chatId}.`)
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to send chat message: ${msg}`, true)
    }
  },
)
