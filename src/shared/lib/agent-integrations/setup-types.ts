import type { z } from 'zod'
import type { AgentIntegrationRecord, IntegrationStatus } from './types'

export interface IntegrationSetupContext {
  agentSlug: string
  userId?: string
  /** Host-selected callback, never accepted from the request body. */
  callbackUrl: string
}
export interface IntegrationProviderSetup {
  /** Agent-side setup is opt-in; owner-managed accounts require the user UI. */
  allowAgentCreation?: boolean
  prepare(input: unknown, context: IntegrationSetupContext): Promise<{ config: Record<string, unknown>; status?: IntegrationStatus }>
  testCredentials?(input: unknown): Promise<Record<string, unknown>>
  authorize?: {
    inputSchema: z.ZodType
    run(record: AgentIntegrationRecord, input: unknown, context: IntegrationSetupContext): Promise<{ url: string }>
  }
  /** Provider validates and consumes its own expiring OAuth state before returning an installation ID. */
  callback?(input: { state: string; code?: string; error?: string }): Promise<{ integrationId?: string; cancelled?: boolean }>
}
export class IntegrationSetupError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 404 | 429 = 400) { super(message) }
}
