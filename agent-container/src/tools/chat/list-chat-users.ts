import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callChatHost, textResult, XAgentError } from './host-client'

interface DirectoryUser {
  id: string
  name: string
  title?: string
}

interface UsersResult {
  provider: string
  users: DirectoryUser[]
  truncated: boolean
}

export const listChatUsersTool = tool(
  'list_chat_users',
  `List the people reachable through a chat integration's directory (e.g. Slack workspace members), with their names and user IDs.

Use this to find the right person BEFORE sending a proactive direct message: pass the user_id to send_chat_message and it will open (or reuse) the 1:1 conversation — no existing chat with that person is needed.

Only integrations whose capabilities include list_users support this (see list_chat_integrations). Large workspaces are capped; a truncated listing says so.`,
  {
    integration_id: z.string().describe('ID of the chat integration whose directory to list'),
  },
  async ({ integration_id }) => {
    try {
      const data = await callChatHost<UsersResult>('users', { integration_id })
      if (data.users.length === 0) {
        return textResult('No users found in this integration\'s directory.')
      }
      const lines = data.users.map((u) => `- ${u.name}${u.title ? ` (${u.title})` : ''} — user_id: ${u.id}`)
      const header = `Users on ${data.provider} (${data.users.length}${data.truncated ? ', truncated — more exist' : ''}):`
      return textResult(`${header}\n${lines.join('\n')}`)
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to list chat users: ${msg}`, true)
    }
  },
)
