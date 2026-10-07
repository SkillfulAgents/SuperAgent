import type { RequestDefinition } from '../requests/definition'

export const mcpReauthRequestDef = {
  kind: 'mcp_reauth_required',
  getNotification: () => null,
} satisfies RequestDefinition
