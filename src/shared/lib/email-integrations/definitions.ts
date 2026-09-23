import type { AgentIntegrationRecord, IntegrationRoute } from '../agent-integrations/types'

export const emailDefinition = {
  provider: 'platform-email', name: 'Email', family: 'email', managementAccess: 'owner', managementCapabilities: [], capabilities: ['send_email', 'list_users', 'list_channels'], settings: [],
  setup: { kind: 'platform-email', credentialFields: [] },
} as const
export const emailSessionPolicy = (integration: AgentIntegrationRecord, route: Partial<IntegrationRoute>) => ({
  timeoutHours: null, name: route.displayName || integration.name || 'Email conversation',
  metadata: { isChatIntegrationSession: true, chatIntegrationId: integration.id },
})
