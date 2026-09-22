import type { AgentIntegrationRecord } from './types'

export type IntegrationCapability = 'reset_conversation' | 'session_timeout' | 'tool_activity'

/** Credential-free fields shared by every integration family. */
export type PublicAgentIntegration<Settings extends object = object> = Pick<AgentIntegrationRecord,
  | 'id' | 'agentSlug' | 'provider' | 'name' | 'status' | 'errorMessage'
  | 'createdByUserId' | 'model' | 'effort' | 'speed' | 'createdAt' | 'updatedAt'
> & {
  /** Whether the provider's stored credentials validate. */
  hasCredentials: boolean
  /** Expiry of an in-progress external authorization; absent when settled. */
  authorizationPendingUntil?: number
  /** Opt-in refresh cadence for provider health on the detail page. */
  refreshIntervalMs?: number
  /** Each family explicitly selects its non-secret settings. */
  settings: Settings
  healthMessage?: string
  reconnectRequired?: boolean
  capabilities?: readonly IntegrationCapability[]
  managementAccess?: 'user' | 'owner'
}

/** Missing capabilities only occurs with legacy chat API responses. */
export function integrationSupports(integration: PublicAgentIntegration, capability: IntegrationCapability): boolean {
  return integration.capabilities?.includes(capability) ?? true
}
