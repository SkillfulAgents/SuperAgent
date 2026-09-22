import type { z } from 'zod'
import type { IntegrationSetupMetadata } from './setup-schema'
import type { AgentIntegrationRecord, IntegrationStatus } from './types'

export interface IntegrationSetupContext {
  agentSlug: string
  userId?: string
  /** Host-selected callback, never accepted from the request body. */
  callbackUrl: string
}
export interface IntegrationProviderSetup {
  /** Read-only setup links; must not create an installation or persist credentials. */
  describe?(context: IntegrationSetupContext, name?: string): IntegrationSetupMetadata | Promise<IntegrationSetupMetadata>
  /** Agent-side setup is opt-in; owner-managed accounts require the user UI. */
  allowAgentCreation?: boolean
  prepare(input: unknown, context: IntegrationSetupContext): Promise<{ config: Record<string, unknown>; status?: IntegrationStatus }>
  testCredentials?(input: unknown): Promise<Record<string, unknown>>
  authorize?: {
    inputSchema: z.ZodType
    /** Validate and persist the attempt before returning its URL. A failure must leave the account usable. */
    run(record: AgentIntegrationRecord, input: unknown, context: IntegrationSetupContext): Promise<{ url: string }>
  }
  /** Validate and consume expiring state, then persist credentials. The host resumes the returned installation. */
  callback?(input: { state: string; code?: string; error?: string }): Promise<{ integrationId?: string; cancelled?: boolean }>
}
/** Provider credential errors are not app-session 401s. 403 is for setup access policy. */
export class IntegrationSetupError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 429 = 400) { super(message) }
}
