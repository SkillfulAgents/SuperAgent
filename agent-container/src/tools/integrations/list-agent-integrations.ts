import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { callHost, textResult, XAgentError } from '../agents/host-client'

const integrationSchema = z.object({
  id: z.string(), provider: z.string(), family: z.string(), name: z.string().nullable(), status: z.string(),
  capabilities: z.array(z.string()), address: z.string().optional(), instructions: z.string().optional(),
  sessions: z.array(z.object({ externalId: z.string(), displayName: z.string().nullable(), type: z.string().optional() })),
  mcp: z.object({ name: z.string(), status: z.string(), identity: z.object({ name: z.string(), provider: z.string(), workspace: z.string().optional() }), tools: z.array(z.string()) }).nullable(),
})
export const listAgentIntegrationsTool = tool(
  'list_agent_integrations',
  `List all external integrations owned by this agent, including their identity, provider, family, status, capabilities, active sessions and integration-owned MCP tools.
Read each integration's instructions before choosing tools. For send_email integrations, send_chat_message requires an email object with recipients, subject and idempotency_key; chat_id/user_id do not apply. Look up users only when the recipient address is unknown; look up channels only to reply to an existing thread. No existing sessions are required for a new email.
Use the named MCP server for integrations with MCP access. For send_message integrations, use send_chat_message with the integration ID and the session externalId as chat_id. list_users / list_channels / dm_by_user_id advertise additional chat discovery operations. Paused or disconnected accounts remain visible so you can explain their status; credentials are never returned.`,
  {},
  async () => {
    try {
      const data = await callHost('integrations/list', {}, z.object({ integrations: z.array(integrationSchema) }))
      return textResult(data.integrations.length ? JSON.stringify(data, null, 2) : 'No agent integrations configured. For chat setup, call list_available_chat_providers, collect the required configuration, then call add_chat_integration. Other integrations can be set up from the agent home page.')
    } catch (error) {
      return textResult(`Failed to list agent integrations: ${error instanceof XAgentError ? error.message : String(error)}`, true)
    }
  },
)
