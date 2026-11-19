import { tool } from '@anthropic-ai/claude-agent-sdk'
import { callChatHost, textResult, XAgentError } from './host-client'

interface Providers {
  providers: Array<{ provider: string; name: string; guide?: string; unavailable?: string }>
  webhookRelay: boolean
}

export const listAvailableIntegrationProvidersTool = tool(
  'list_available_integration_providers',
  `List every agent integration provider this host supports (chat bots, the agent's own email inbox, its own Linear or GitHub app, and any other), with how you set each one up: what to pass to add_agent_integration, and what to do in your browser.

Each gives this agent its own identity on a service. Offer to do the setup for the user with your browser tools: create the app or bot in the service and fill in what it gives you. The user only logs in when a login page appears (ask with request_browser_input).`,
  {},
  async () => {
    try {
      const { providers, webhookRelay } = await callChatHost<Providers>('providers', {})
      const sections = providers.map(({ provider, name, guide, unavailable }) =>
        `## ${name} (provider \`${provider}\`)\n${unavailable ?? guide}`)
      const relay = `This host has ${webhookRelay ? 'a' : 'no'} webhook relay.`
      return textResult(`Set a provider up with add_agent_integration, passing its fields in config.\n\n${sections.join('\n\n')}\n\n${relay}`)
    } catch (error) {
      return textResult(`Failed to list integration providers: ${error instanceof XAgentError ? error.message : String(error)}`, true)
    }
  },
)
