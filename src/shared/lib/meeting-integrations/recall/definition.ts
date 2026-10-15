import type { AgentIntegrationDefinition } from '../../agent-integrations/types'
import { MEETING_AGENT_INSTRUCTIONS, MEETING_CAPABILITIES, MEETING_FAMILY } from '../definitions'

export const recallDefinition: AgentIntegrationDefinition = {
  provider: 'recall', name: 'Meetings', family: MEETING_FAMILY, managementAccess: 'owner',
  capabilities: MEETING_CAPABILITIES,
  managementCapabilities: [],
  agentInstructions: MEETING_AGENT_INSTRUCTIONS,
  settings: [],
  // Reached through the platform; the installation stores no credential.
  setup: { kind: 'platform', credentialFields: [] },
}
