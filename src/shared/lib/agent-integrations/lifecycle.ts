import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { chatIntegrations } from '../db/schema'
import { integrationConfigSchema } from './config-schema'
import { captureException } from '../error-reporting'

export interface IntegrationReconnectRequired {
  integrationId: string
  /** Exact credential/config revision being invalidated, not a stale connector snapshot. */
  expectedConfig: string
  config: Record<string, unknown>
  message: string
}
export interface IntegrationAuthorizationLost {
  integrationId: string
  config: string
}
const listeners = new Set<(change: IntegrationAuthorizationLost) => void>()

export function onIntegrationAuthorizationLost(listener: (change: IntegrationAuthorizationLost) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Terminal lifecycle transition shared by inbound transports and outbound MCP.
 * Clearing the credential and disabling its installation are one conditional write.
 * A stale failure cannot revoke replacement credentials or override a user pause.
 */
export async function requireIntegrationReconnect(change: IntegrationReconnectRequired): Promise<boolean> {
  const config = JSON.stringify(integrationConfigSchema.parse(change.config))
  const changed = await db.update(chatIntegrations).set({ config,
    status: sql`case when ${chatIntegrations.status} = 'paused' then 'paused' else 'disconnected' end`,
    errorMessage: change.message, updatedAt: new Date(),
  }).where(and(eq(chatIntegrations.id, change.integrationId), eq(chatIntegrations.config, change.expectedConfig)))
    .returning({ id: chatIntegrations.id }).get()
  if (!changed) return false
  for (const listener of listeners) {
    try { listener({ integrationId: change.integrationId, config }) }
    catch (error) { captureException(error, { tags: { component: 'agent-integration', operation: 'authorization-lost' } }) }
  }
  return true
}
