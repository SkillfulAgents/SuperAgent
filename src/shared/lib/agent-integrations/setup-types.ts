import type { z } from 'zod'
import type { VerificationProfile } from '../services/webhook-endpoint-schema'
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
  /**
   * Agent-side setup is opt-in. Without it the agent can only ask the owner,
   * who sets the account up in the app (see owner-setup-request.ts).
   */
  allowAgentCreation?: boolean
  /**
   * What the agent does next with an installation it created that is not
   * connected yet (an app to create in its browser, credentials to bring
   * back to `authorize`). Links and instructions only, never credentials.
   */
  agentNextStep?(record: AgentIntegrationRecord): string
  /**
   * `relay: true` sets up webhooks: the host mints the endpoint before the
   * installation exists, with `verification` if the provider can give it.
   */
  prepare(input: unknown, context: IntegrationSetupContext): Promise<{ config: Record<string, unknown>; status?: IntegrationStatus; relay?: boolean; verification?: VerificationProfile }>
  testCredentials?(input: unknown): Promise<Record<string, unknown>>
  authorize?: {
    inputSchema: z.ZodType
    /** Validate and persist the attempt before returning its URL. A failure must leave the account usable. */
    run(record: AgentIntegrationRecord, input: unknown, context: IntegrationSetupContext): Promise<{ url: string }>
  }
  /** Browser form handoff for providers whose setup starts with a POST. Validate expiring state before returning fields. */
  launch?(state: string): Promise<{ url: string; fields: Record<string, string> }>
  /** Validate and consume expiring state, then persist credentials. The host resumes the returned installation. */
  callback?(input: { state: string; code?: string; error?: string; parameters?: Record<string, string> }): Promise<{ integrationId?: string; cancelled?: boolean; redirectUrl?: string }>
}
/** Provider credential errors are not app-session 401s. 403 is for setup access policy. */
export class IntegrationSetupError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 429 = 400) { super(message) }
}
