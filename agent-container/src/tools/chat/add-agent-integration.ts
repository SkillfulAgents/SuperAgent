import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../../input-manager'
import { callChatHost, textResult, XAgentError } from './host-client'

interface AddResult {
  id: string
  provider: string
  status: string
  name: string | null
  /** For an installation that still needs authorization: what to do in the browser next. */
  nextStep?: string
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
    `Give this agent its own identity on an external service: a chat bot (Telegram, Slack, iMessage), its own Linear or GitHub app, or its own email inbox.

Call list_agent_integrations first: the integration may already exist. Then call list_available_integration_providers for each provider's fields and setup steps.

Telegram, Slack and iMessage: collect the provider's fields (or create the bot yourself in your browser) and pass them in config. The integration is created when this returns.

Linear and GitHub: you set these up in your browser. This creates the integration and returns its next step: the app to create (Linear) or authorize_agent_integration to call. Finish with authorize_agent_integration.

Email (platform-email) can only be set up by the agent's owner. This tool asks them with a setup card in the app and returns once the inbox is connected, or with an error if they decline; that can take a while. You may suggest a name (the sender name) and config.localPart (the inbox name before the @); pass a reason saying what the inbox is for.

These are the agent's own accounts, not the user's: to act as the user in their own Gmail, Linear or GitHub, use request_connected_account instead.`,
    {
      provider: z.enum(AGENT_INTEGRATION_PROVIDERS).describe('Provider to set up'),
      config: z.record(z.string(), z.unknown()).optional().describe('Provider-specific fields (see list_available_integration_providers)'),
      name: z.string().optional().describe('Optional display name: the bot name, the Linear/GitHub app name, or the email sender name'),
      reason: z.string().optional().describe('For Email: one sentence on what the inbox is for, shown to the owner'),
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
        (created.name ? `\n  Name: ${created.name}` : '') +
        (created.nextStep ? `\n\nNext step:\n${created.nextStep}` : ''),
      )
    },
  )
}
