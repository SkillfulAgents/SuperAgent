/** Persisted provider IDs. Kept independent of implementations for schema/UI imports. */
export const AGENT_INTEGRATION_PROVIDERS = ['telegram', 'slack', 'imessage', 'linear', 'platform-email'] as const
export type AgentIntegrationProvider = typeof AGENT_INTEGRATION_PROVIDERS[number]
