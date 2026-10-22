import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callChatHost, textResult, XAgentError } from './host-client'

const finishing = (integrationId: string) =>
  `The provider sends the browser back to Gamut when you approve, and that page says the account is connected. ` +
  `If that page does not load, call complete_agent_integration_authorization with integration_id "${integrationId}" and the full address from the address bar. ` +
  `Then call list_agent_integrations to confirm the integration is active.`

export const authorizeAgentIntegrationTool = tool(
  'authorize_agent_integration',
  `Get the authorization link for a Linear or GitHub integration this agent created with add_agent_integration, then open it in your browser and approve it.

For Linear, pass the app's credentials you copied after creating the app: config {clientId, clientSecret, webhookSecret}. For GitHub, pass no config.`,
  {
    integration_id: z.string().describe('The integration ID add_agent_integration returned'),
    config: z.record(z.string(), z.unknown()).optional().describe('Linear: {clientId, clientSecret, webhookSecret}. GitHub: omit'),
  },
  async ({ integration_id, config }) => {
    try {
      const { url } = await callChatHost<{ url: string }>('authorize', { integration_id, config })
      return textResult(`Open this link in your browser and approve it:\n${url}\n\n${finishing(integration_id)}`)
    } catch (error) {
      return textResult(`Failed to authorize the integration: ${error instanceof XAgentError ? error.message : String(error)}`, true)
    }
  },
)

export const completeAgentIntegrationAuthorizationTool = tool(
  'complete_agent_integration_authorization',
  `Finish authorizing an integration when your browser could not load the page the provider sent it back to (an error page, or an address on this machine your browser cannot reach). Pass the full address from the address bar; it carries the authorization the provider granted.`,
  {
    integration_id: z.string().describe('The integration being authorized'),
    url: z.string().describe('The full address the provider redirected the browser to, including its query string'),
  },
  async ({ integration_id, url }) => {
    try {
      const result = await callChatHost<{ status: string; url?: string }>('complete-authorization', { integration_id, url })
      if (result.status === 'continue' && result.url) {
        return textResult(`One more step: open this link in your browser and finish there:\n${result.url}\n\n${finishing(integration_id)}`)
      }
      return textResult(`Authorization complete. Integration status: ${result.status}.`)
    } catch (error) {
      return textResult(`Failed to complete authorization: ${error instanceof XAgentError ? error.message : String(error)}`, true)
    }
  },
)
