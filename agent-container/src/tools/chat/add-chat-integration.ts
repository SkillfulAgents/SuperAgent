import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callChatHost, textResult, XAgentError } from './host-client'

interface AddResult {
  id: string
  provider: string
  status: string
  name: string | null
}

export const addChatIntegrationTool = tool(
  'add_chat_integration',
  `Add a new chat integration for this agent. Supports Telegram, Slack, and iMessage.

Before calling this tool, use list_available_chat_providers to see what configuration fields are needed for each provider, then collect the required information from the user.

For Telegram: you need the botToken from @BotFather.
For Slack: you need the botToken (xoxb-) and appToken (xapp-) from the Slack app settings.
For iMessage: you need the phone number (E.164 format) and a 6-digit verification code.

The config parameter should be a JSON object with the provider-specific fields.`,
  {
    provider: z.enum(['telegram', 'slack', 'imessage']).describe('Chat provider to set up'),
    config: z.record(z.string(), z.unknown()).describe('Provider-specific configuration (see list_available_chat_providers for required fields)'),
    name: z.string().optional().describe('Optional display name for this integration'),
  },
  async ({ provider, config, name }) => {
    try {
      const data = await callChatHost<AddResult>('add', {
        provider,
        config,
        name,
      })
      return textResult(
        `Chat integration created successfully.\n` +
        `  Provider: ${data.provider}\n` +
        `  ID: ${data.id}\n` +
        `  Status: ${data.status}` +
        (data.name ? `\n  Name: ${data.name}` : ''),
      )
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to add chat integration: ${msg}`, true)
    }
  },
)
