import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callChatHost, textResult, XAgentError } from './host-client'

interface AddResult {
  id: string
  provider: string
  status: string
  name: string | null
  /** For an installation that is not connected yet: what to do next. */
  nextStep?: string
}

export const addAgentIntegrationTool = tool(
  'add_agent_integration',
  `Give this agent its own identity on an external service: a chat bot, its own email inbox, its own Linear or GitHub app.

Call list_agent_integrations first: the integration may already exist. Then call list_available_integration_providers for the provider's fields and setup steps, and pass those fields in config.

Some providers are connected when this returns. Others return a next step to finish in your browser, ending with authorize_agent_integration.

These are the agent's own accounts, not the user's: to act as the user in their own Gmail, Linear or GitHub, use request_connected_account instead.`,
  {
    provider: z.string().describe('Provider to set up, as list_available_integration_providers names it'),
    config: z.record(z.string(), z.unknown()).optional().describe('Provider-specific fields (see list_available_integration_providers)'),
    name: z.string().optional().describe('Optional display name for this integration, such as the bot or app name'),
  },
  async ({ provider, config, name }) => {
    try {
      const data = await callChatHost<AddResult>('add', { provider, config, name })
      return textResult(
        `Integration created successfully.\n` +
        `  Provider: ${data.provider}\n` +
        `  ID: ${data.id}\n` +
        `  Status: ${data.status}` +
        (data.name ? `\n  Name: ${data.name}` : '') +
        (data.nextStep ? `\n\nNext step:\n${data.nextStep}` : ''),
      )
    } catch (error) {
      const msg = error instanceof XAgentError ? error.message : String(error)
      return textResult(`Failed to add agent integration: ${msg}`, true)
    }
  },
)
