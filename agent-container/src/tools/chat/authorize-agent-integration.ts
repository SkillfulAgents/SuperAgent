import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callChatHost, textResult, XAgentError } from './host-client'

const finishing = (integrationId: string) =>
  `The provider sends the browser back to Gamut when you approve, and that page says the account is connected. ` +
  `If that page does not load, call authorize_agent_integration again with integration_id "${integrationId}" and redirect_url set to the full address from the address bar. ` +
  `Then call list_agent_integrations to confirm the integration is active.`

export const authorizeAgentIntegrationTool = tool(
  'authorize_agent_integration',
  `Get the authorization link for an integration this agent created with add_agent_integration, then open it in your browser and approve it. Pass in config what the provider's setup steps say to bring back (an app's credentials).

If the page the provider sends your browser back to does not load (an error page, or an address your browser cannot reach), call this again with redirect_url: the full address from the address bar, which carries the authorization the provider granted.`,
  {
    integration_id: z.string().describe('The integration ID add_agent_integration returned'),
    config: z.record(z.string(), z.unknown()).optional().describe('What the provider needs to authorize (see list_available_integration_providers)'),
    redirect_url: z.string().optional().describe('Only to finish an authorization whose return page did not load: the full address the provider redirected the browser to'),
  },
  async ({ integration_id, config, redirect_url }) => {
    try {
      if (!redirect_url) {
        const { url } = await callChatHost<{ url: string }>('authorize', { integration_id, config })
        return textResult(`Open this link in your browser and approve it:\n${url}\n\n${finishing(integration_id)}`)
      }
      const result = await callChatHost<{ status: string; url?: string }>('complete-authorization', { integration_id, url: redirect_url })
      if (result.status === 'continue' && result.url) {
        return textResult(`One more step: open this link in your browser and finish there:\n${result.url}\n\n${finishing(integration_id)}`)
      }
      return textResult(`Authorization complete. Integration status: ${result.status}.`)
    } catch (error) {
      return textResult(`Failed to authorize the integration: ${error instanceof XAgentError ? error.message : String(error)}`, true)
    }
  },
)
