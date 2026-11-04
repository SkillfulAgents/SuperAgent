import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { chatIntegrations } from '../db/schema'
import { integrationConfigSchema } from './config-schema'
import { captureException } from '../error-reporting'
import { publishIntegrationAuthorization } from './authorization-events'
import { deliveryStore } from './delivery-store'

export interface IntegrationReconnectRequired {
  integrationId: string
  /** Exact credential/config revision being invalidated, not a stale connector snapshot. */
  expectedConfig: string
  config: Record<string, unknown>
  message: string
}

/** Terminal lifecycle transition shared by inbound transports and outbound MCP.
 * Clearing the credential and disabling its installation are one conditional write.
 * A stale failure cannot revoke replacement credentials or override a user pause.
 * Only once that write has landed: the input it accepted is cancelled here, and
 * the connection's owner, in whichever process, is sent a hint to tear down.
 */
export async function requireIntegrationReconnect(change: IntegrationReconnectRequired): Promise<boolean> {
  const config = JSON.stringify(integrationConfigSchema.parse(change.config))
  const changed = await db.update(chatIntegrations).set({ config,
    status: sql`case when ${chatIntegrations.status} = 'paused' then 'paused' else 'disconnected' end`,
    errorMessage: change.message, updatedAt: new Date(),
  }).where(and(eq(chatIntegrations.id, change.integrationId), eq(chatIntegrations.config, change.expectedConfig)))
    .returning({ id: chatIntegrations.id }).get()
  if (!changed) return false
  // Not left to the hint, which can be missed: input accepted under the rejected
  // credential must not run once the installation is authorized again.
  await deliveryStore.cancelStopped(change.integrationId)
  try { await publishIntegrationAuthorization({ type: 'authorization_lost', integrationId: change.integrationId }) }
  catch (error) { captureException(error, { tags: { component: 'agent-integration', operation: 'authorization-lost' } }) }
  return true
}
