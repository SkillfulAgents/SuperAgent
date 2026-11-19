/**
 * Request Integration Setup Tool - hands an agent integration's setup to the user
 *
 * This tool creates a pending request that blocks until an integration of the
 * provider connects for this agent (the host answers it then) or the user
 * declines. The user finishes the setup in the app's own form.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { inputManager } from '../input-manager'
import { callChatHost, textResult, XAgentError } from './chat/host-client'

interface Providers {
  providers: Array<{ provider: string; name: string; unavailable?: string }>
}

export const requestIntegrationSetupTool = tool(
  'request_integration_setup',
  `Hand the setup of an agent integration (a chat bot, the agent's own email inbox, its own Linear or GitHub app) to the user. A card in this session opens the provider's setup form in the app, starting from the values you suggest. This returns once the integration is connected, or with an error if the user declines; that can take a while.

Follow the provider's entry in list_available_integration_providers: some say to hand the setup over by default, because it is quicker for the user in their own browser than for you. Otherwise set integrations up yourself, with add_agent_integration and your browser, and hand the setup over when:
- the listing marks the provider "one click" (this workspace can create its app, which only the user can use);
- the user wants to do it themselves, or will not log in to the service in your browser;
- only they can get past a step (single sign-on, a second factor, an admin's approval);
- you have no browser.

Choose before calling add_agent_integration: the form creates the integration itself.`,
  {
    provider: z.string().describe('Provider to set up, as list_available_integration_providers names it'),
    reason: z.string().describe('One sentence the user sees on the card: what the integration is for'),
    prefill: z
      .record(z.string(), z.string())
      .optional()
      .describe('Starting values for the form: {name} (the bot or app name); Email also {localPart, displayName}; GitHub also {organization}. Never credentials.'),
  },
  async ({ provider }) => {
    // Get the toolUseId that was captured by the PreToolUse hook
    const toolUseId = inputManager.consumeCurrentToolUseId()
    if (!toolUseId) {
      return textResult('Unable to process the integration setup request - no tool use ID available.', true)
    }

    try {
      const { providers } = await callChatHost<Providers>('providers', {})
      const listed = providers.find((candidate) => candidate.provider === provider)
      if (!listed) return textResult(`Unknown provider "${provider}". Call list_available_integration_providers for the providers this host supports.`, true)
      if (listed.unavailable) return textResult(`${listed.name} cannot be set up on this host: ${listed.unavailable}`, true)
    } catch (error) {
      return textResult(`Failed to check the provider: ${error instanceof XAgentError ? error.message : String(error)}`, true)
    }

    try {
      // This blocks until the integration connects or the user declines
      return textResult(await inputManager.createPendingWithType<string>(toolUseId, 'integration_setup', { provider }))
    } catch (error) {
      return textResult(`${provider} was not set up: ${error instanceof Error ? error.message : 'Unknown error'}`, true)
    }
  },
)
