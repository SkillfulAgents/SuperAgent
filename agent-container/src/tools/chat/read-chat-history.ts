import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callChatHost, textResult, XAgentError } from './host-client'

/**
 * @param getCallerSessionId - getter for the current Claude session ID at
 *   tool-invocation time. The host reads that session's own conversation, so
 *   the tool can only read the chat this session is in.
 */
export function makeReadChatHistoryTool(getCallerSessionId: () => string) {
  return tool(
    'read_chat_history',
    `Read earlier messages of the chat conversation this session is in (for example a Slack channel and its threads).
Without thread_ts, returns the top level of the conversation (in a channel: its top-level messages, not the replies inside threads), newest 50, shown oldest first. A message that started a thread is marked "[thread <ts>, N replies]". To read your own thread or any other, pass its thread_ts.
With thread_ts, returns that thread from its first message.
Each line reads "Name (YYYY-MM-DD HH:MM UTC): text", with "[file: name]" for attachments. Very long messages are cut and marked "…(cut)".
At most 50 messages per call. When there are more, the result ends with the exact call for the next page: pass its cursor (and thread_ts for a thread). A cursor belongs to the call that produced it. A channel pages back in time, a thread forward. Use it when the conversation refers to something said earlier that you do not have, such as another thread in the same channel.
Reads only this conversation. Works only in a chat conversation's session, and only where the integration's capabilities include read_history.`,
    {
      thread_ts: z.string().optional().describe('Timestamp of a thread in this conversation, as shown in "[thread <ts>, ...]"'),
      cursor: z.string().optional().describe('Continue a previous read: the cursor from its "call again with cursor=..." line'),
    },
    async ({ thread_ts, cursor }) => {
      try {
        const data = await callChatHost<{ history: string }>('history', { session_id: getCallerSessionId(), thread_ts, cursor })
        return textResult(data.history)
      } catch (error) {
        const msg = error instanceof XAgentError ? error.message : String(error)
        return textResult(`Failed to read chat history: ${msg}`, true)
      }
    },
  )
}
