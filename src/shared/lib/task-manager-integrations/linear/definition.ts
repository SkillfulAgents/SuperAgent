import type { AgentIntegrationDefinition } from '../../agent-integrations/types'

export const linearDefinition: AgentIntegrationDefinition = {
  provider: 'linear', name: 'Linear', family: 'task-manager', managementAccess: 'owner',
  capabilities: ['issue_sessions', 'mentions', 'delegation', 'mcp'],
  settings: [{ key: 'runOnStatusChange', label: 'Run when an involved issue changes status', type: 'boolean' }],
  setup: { kind: 'private-oauth-app', credentialFields: ['clientId', 'clientSecret'] },
}
