import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../../input-manager'
import { callChatHost, textResult, XAgentError } from './host-client'

interface AddResult {
  id: string
  provider: string
  status: string
  name: string | null
}

interface OwnerSetupRequested {
  status: 'owner_setup_requested'
  provider: string
}

export const AGENT_INTEGRATION_PROVIDERS = ['telegram', 'slack', 'imessage', 'platform-email', 'linear', 'github'] as const

/**
 * @param getCallerSessionId - getter for the current Claude session ID. An
 *   owner-approved provider's setup card opens in this session.
 */
export function makeAddAgentIntegrationTool(getCallerSessionId: () => string) {
  return tool(
    'add_agent_integration',
    `Give this agent its own identity on an external service: a chat bot (Telegram, Slack, iMessage), its own email inbox, or its own Linear or GitHub app.

Call list_agent_integrations first: the integration may already exist. Then call list_available_integration_providers for each provider's fields and setup steps.

Telegram, Slack and iMessage are set up directly: collect the provider's fields from the user and pass them in config. The integration is created when this returns.

Email (platform-email), Linear and GitHub can only be set up by the agent's owner. This tool asks them with a setup card in the app and returns once the integration is connected, or with an error if they decline. That can take a while. Never collect credentials for these: the owner enters them in the app. You may suggest a name, and for Email config.localPart (the inbox name before the @), for GitHub config.organization; the owner can change them.

Use reason to tell the owner what the integration is for. These are the agent's own accounts, not the user's: to act as the user in their own Gmail, Linear or GitHub, use request_connected_account instead.`,
    {
      provider: z.enum(AGENT_INTEGRATION_PROVIDERS).describe('Provider to set up'),
      config: z.record(z.string(), z.unknown()).optional().describe('Provider-specific fields (see list_available_integration_providers). Required for Telegram, Slack and iMessage; optional suggestions for the rest'),
      name: z.string().optional().describe('Optional display name: the bot name, the email sender name, or the Linear/GitHub app name'),
      reason: z.string().optional().describe('For owner-approved providers: one sentence on what the integration is for, shown to the owner'),
    },
    async ({ provider, config, name, reason }) => {
      const toolUseId = inputManager.consumeCurrentToolUseId()
      let data: AddResult | OwnerSetupRequested
      try {
        data = await callChatHost<AddResult | OwnerSetupRequested>('add', {
          provider, config, name, reason, toolUseId, sessionId: getCallerSessionId(),
        })
      } catch (error) {
        const msg = error instanceof XAgentError ? error.message : String(error)
        return textResult(`Failed to add agent integration: ${msg}`, true)
      }

      if (data.status === 'owner_setup_requested') {
        if (!toolUseId) return textResult('Unable to wait for the owner: no tool use ID available.', true)
        try {
          return textResult(await inputManager.createPendingWithType<string>(toolUseId, 'integration_setup', { provider }))
        } catch (error) {
          return textResult(`${provider} was not set up: ${error instanceof Error ? error.message : 'Unknown error'}`, true)
        }
      }

      const created = data as AddResult
      return textResult(
        `Integration created successfully.\n` +
        `  Provider: ${created.provider}\n` +
        `  ID: ${created.id}\n` +
        `  Status: ${created.status}` +
        (created.name ? `\n  Name: ${created.name}` : ''),
      )
    },
  )
}
