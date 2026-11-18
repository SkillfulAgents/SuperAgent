import type { AgentIntegrationDefinition } from '../../agent-integrations/types'

export const githubDefinition: AgentIntegrationDefinition = {
  provider: 'github', name: 'GitHub', family: 'task-manager', managementAccess: 'owner',
  capabilities: ['issue_sessions', 'mentions', 'mcp'], settings: [],
  setup: { kind: 'app-manifest', credentialFields: [] }, transports: ['relay'],
}
