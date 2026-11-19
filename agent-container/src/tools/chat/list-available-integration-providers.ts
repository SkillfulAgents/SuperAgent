import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callChatHost, textResult, XAgentError } from './host-client'

interface Providers {
  providers: Array<{ provider: string; name: string; guide?: string; unavailable?: string; oneClickWorkspace?: string }>
  webhookRelay: boolean
}

export const listAvailableIntegrationProvidersTool = tool(
  'list_available_integration_providers',
  `List every agent integration provider this host supports (chat bots, the agent's own email inbox, its own Linear or GitHub app, and any other), with how you set each one up: what to pass to add_agent_integration, and what to do in your browser.

Each gives this agent its own identity on a service. Offer to do the setup for the user with your browser tools: create the app or bot in the service and fill in what it gives you. The user only logs in when a login page appears (ask with request_browser_input).

Where a provider's entry says to hand its setup to the user, or marks it "one click", do that with request_integration_setup instead; it also suits a user who would rather do the setup themselves.

To compare a provider with the user's own account or MCP for the same service, use search_connection_options.`,
  {
    provider: z.string().optional().describe('Only this provider, as search_connection_options or this listing names it. Omit to list every provider.'),
  },
  async (args) => {
    try {
      const { providers: all, webhookRelay } = await callChatHost<Providers>('providers', {})
      const providers = args.provider ? all.filter(({ provider }) => provider === args.provider) : all
      if (providers.length === 0) {
        return textResult(`No integration provider "${args.provider}". Providers on this host: ${all.map(({ provider }) => provider).join(', ')}.`, true)
      }
      const sections = providers.map(({ provider, name, guide, unavailable, oneClickWorkspace }) => {
        const oneClick = oneClickWorkspace
          ? `One click: the ${oneClickWorkspace} team directory creates this app for the user in the app's setup form. Hand the setup over with request_integration_setup instead of the steps below.\n`
          : ''
        return `## ${name} (provider \`${provider}\`)\n${oneClick}${unavailable ?? guide}`
      })
      const relay = `This host has ${webhookRelay ? 'a' : 'no'} webhook relay.`
      return textResult(`Set a provider up with add_agent_integration, passing its fields in config, or hand its setup to the user with request_integration_setup.\n\n${sections.join('\n\n')}\n\n${relay}`)
    } catch (error) {
      return textResult(`Failed to list integration providers: ${error instanceof XAgentError ? error.message : String(error)}`, true)
    }
  },
)
