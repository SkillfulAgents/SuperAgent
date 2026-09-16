import type { AgentIntegrationRecord } from './types'

/** Credential-free fields shared by every integration family. */
export type PublicAgentIntegration<Settings extends object = object> = Pick<AgentIntegrationRecord,
  | 'id' | 'agentSlug' | 'provider' | 'name' | 'status' | 'errorMessage'
  | 'createdByUserId' | 'model' | 'effort' | 'speed' | 'createdAt' | 'updatedAt'
> & {
  /** Whether the provider's stored credentials validate. */
  hasCredentials: boolean
  /** Each family explicitly selects its non-secret settings. */
  settings: Settings
}
