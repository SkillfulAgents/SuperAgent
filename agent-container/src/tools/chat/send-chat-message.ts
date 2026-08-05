import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callChatHost, textResult, XAgentError } from './host-client'

interface SendResult {
  chatId: string
  provider: string
}

/**
 * @param getCallerSessionId - getter for the current Claude session ID at
 *   tool-invocation time. Sent with each request so the host can tell when the
 *   caller is itself a chat-conversation session and reject sends that would
 *   double-post into the caller's own chat (replies already stream there).
 */
export function makeSendChatMessageTool(getCallerSessionId: () => string) {
  return tool(
    'send_chat_message',
    `Proactively send a message to a chat through a connected chat integration (Telegram, Slack, or iMessage).

Use this ONLY to initiate contact outside the current conversation — e.g. a scheduled or background run notifying someone, or messaging a DIFFERENT chat than the one this session is responding in (like DMing a specific person while working a channel thread).

If this session was started by an incoming chat message, do NOT use this tool to reply to that conversation: everything you write in your response is already delivered to it automatically, and sending it here too would post it twice.

The destination is either a chat_id (an existing conversation or channel — see list_chat_integrations and list_chat_channels) or a user_id (a person from list_chat_users; the 1:1 conversation is opened automatically, so this works even if they never messaged the bot). Pass one or the other, never both. Omitting both works only when the integration has exactly one active chat. user_id is supported only where the integration's capabilities include dm_by_user_id.

Use the optional context parameter to attach internal notes that help the receiving chat's agent session understand the message's purpose on follow-up. Context is NOT sent to the user — it is only recorded in the session log.`,
    {
      integration_id: z.string().describe('ID of the chat integration to send through'),
      message: z.string().describe('The message text to deliver to the chat'),
      chat_id: z.string().optional().describe('Target chat ID (existing conversation or channel). Required if the integration has multiple active chats and no user_id is given.'),
      user_id: z.string().optional().describe('Provider user ID of a person to DM (from list_chat_users). Opens or reuses the 1:1 conversation. Mutually exclusive with chat_id.'),
      context: z.string().optional().describe('Internal context for session continuity. Not sent to the user — only recorded in the session log.'),
    },
    async ({ integration_id, message, chat_id, user_id, context }) => {
      try {
        const data = await callChatHost<SendResult>('send', {
          integration_id,
          message,
          chat_id,
          user_id,
          context,
          session_id: getCallerSessionId(),
        })
        return textResult(`Message sent via ${data.provider} to chat ${data.chatId}.`)
      } catch (error) {
        const msg = error instanceof XAgentError ? error.message : String(error)
        return textResult(`Failed to send chat message: ${msg}`, true)
      }
    },
  )
}
