import type { z } from 'zod'
import type { IntegrationRelayBinding } from './transport'
import type { VerificationProfile } from '../services/webhook-endpoint-schema'
import type { IntegrationSetupMetadata } from './setup-schema'
import type { AgentIntegrationRecord, IntegrationStatus } from './types'

export interface IntegrationSetupContext {
  agentSlug: string
  userId?: string
  /** Host-selected callback, never accepted from the request body. */
  callbackUrl: string
  /** The agent is setting this up itself, through its tools. */
  fromAgent?: boolean
}
export interface IntegrationProviderSetup {
  /** Read-only setup links; must not create an installation or persist credentials. */
  describe?(context: IntegrationSetupContext, name?: string): IntegrationSetupMetadata | Promise<IntegrationSetupMetadata>
  /**
   * How an agent sets this provider up with its own tools: what to collect or
   * do in its browser, and the config `prepare` and `authorize` take. The
   * agent drives the same hooks the app's setup forms do, so this is all a
   * provider adds to be set up by agents (list_available_integration_providers
   * shows it).
   */
  agentGuide?: string
  /**
   * What the agent does next with an installation it created that is not
   * connected yet, when that takes something only the installation has (a
   * prefilled link). Links and instructions only, never credentials.
   */
  agentNextStep?(record: AgentIntegrationRecord): string
  /**
   * `relay: true` sets up webhooks: the host mints the endpoint before the
   * installation exists, with `verification` if the provider can give it.
   */
  prepare(input: unknown, context: IntegrationSetupContext): Promise<{
    config: Record<string, unknown>
    status?: IntegrationStatus
    relay?: boolean
    verification?: VerificationProfile
    /** Creates provider-specific delivery config once the host has minted the relay endpoint. */
    bindRelay?(relay: IntegrationRelayBinding): Promise<Record<string, unknown>>
  }>
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
