import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callChatHost, textResult, XAgentError } from './host-client'

interface DirectoryChannel {
  id: string
  name: string
  isPrivate?: boolean
  isMember?: boolean
}

interface ChannelsResult {
  provider: string
  channels: DirectoryChannel[]
  truncated: boolean
}

export const listChatChannelsTool = tool(
  'list_chat_channels',
  `List the channels and groups available on a chat integration (e.g. Slack channels), with their names and chat IDs.

Use this to find where to post BEFORE sending a proactive message: pass the chat_id to send_chat_message. The bot may be unable to post in channels it is not a member of — the listing marks membership.

Only integrations whose capabilities include list_channels support this (see list_chat_integrations). Large workspaces are capped; a truncated listing says so.`,
  {
    integration_id: z.string().describe('ID of the chat integration whose channels to list'),
  },
  async ({ integration_id }) => {
    try {
      const data = await callChatHost<ChannelsResult>('channels', { integration_id })
      if (data.channels.length === 0) {
        return textResult('No channels found for this integration.')
      }
      const lines = data.channels.map((ch) => {
        const flags = [
          ch.isPrivate ? 'private' : null,
          ch.isMember === false ? 'bot not a member' : null,
        ].filter(Boolean).join(', ')
        return `- ${ch.name} — chat_id: ${ch.id}${flags ? ` (${flags})` : ''}`
      })
      const header = `Channels on ${data.provider} (${data.channels.length}${data.truncated ? ', truncated — more exist' : ''}):`
      return textResult(`${header}\n${lines.join('\n')}`)
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to list chat channels: ${msg}`, true)
    }
  },
)
