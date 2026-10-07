import type { RequestDefinition } from '../requests/definition'

export const mcpReauthRequestDef = {
  kind: 'mcp_reauth_required',
  describeVoice: (request) => `The agent needs the user to reconnect ${request.mcpName} in the application.`,
  getNotification: () => null,
} satisfies RequestDefinition<'mcp_reauth_required'>
