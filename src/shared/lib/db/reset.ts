import { db } from './index'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import {
  proxyAuditLog,
  proxyTokens,
  agentConnectedAccounts,
  scheduledTasks,
  notifications,
  sessionUnreadMarks,
  connectedAccounts,
  userSettings,
  auditLog,
  webhookTriggers,
  chatIntegrations,
  integrationDeliveries,
  integrationState,
  remoteMcpServers,
  agentRemoteMcps,
  mcpAuditLog,
  mcpToolPolicies,
  agentAcl,
  agents,
  messageAuthor,
  xAgentPolicies,
  apiScopePolicies,
  tokenExchangeJti,
  mobilePairingToken,
  mobileDevice,
  apnsDevices,
  pushSubscriptions,
  pushVapidKeys,
} from './schema'
import { agentIntegrationRegistry } from '../agent-integrations/registry'

/**
 * Canonical set of agent/app-owned relational tables wiped by factory reset.
 *
 * Ordered children-before-parents so deletes succeed regardless of FK-cascade
 * state. Better Auth tables (user, session, account, verification) are
 * intentionally excluded — a factory reset clears app/agent data but does NOT
 * delete user accounts. The data-migration ledger is excluded too, like
 * drizzle's own: it records which one-time moves this database has been
 * through, and a reset database is an empty one, not a legacy one. Re-running
 * those moves after a reset would pull back whatever state the reset did not
 * delete.
 *
 * Keep this reconciled with the per-agent set in agent-cleanup-service.ts. The
 * test in factory-reset.sup206.test.ts enumerates the schema dynamically and
 * fails if a new agent/app-owned table is added without being listed here, so
 * the set cannot silently drift again.
 */
function factoryResetTables(): SQLiteTable[] { return [
  // Leaf / no-FK-to-reset-table audit + attribution rows
  proxyAuditLog,
  proxyTokens,
  mcpAuditLog,
  messageAuthor,
  agentAcl,
  xAgentPolicies,
  webhookTriggers,
  // the agent catalog itself, once the per-agent rows above are gone
  agents,
  notifications,
  sessionUnreadMarks,
  scheduledTasks,
  // Provider-owned child tables precede their installation parent.
  ...agentIntegrationRegistry.storageTables(),
  integrationDeliveries,
  integrationState,
  chatIntegrations,
  // connected accounts + dependents (api scope policies + agent mappings cascade)
  agentConnectedAccounts,
  apiScopePolicies,
  connectedAccounts,
  // remote MCP servers + dependents (tool policies + agent mappings cascade)
  agentRemoteMcps,
  mcpToolPolicies,
  remoteMcpServers,
  // per-user settings (user row itself is preserved)
  userSettings,
  // global app audit log
  auditLog,
  // transient single-use jti replay guard for the token-exchange endpoint
  tokenExchangeJti,
  // transient single-use mobile pairing tokens
  mobilePairingToken,
  // APNs registrations before mobile devices: the cascade covers paired rows,
  // but nullable mobile_device_id rows would survive it
  apnsDevices,
  // stable mobile devices; deleting them cascades their access sessions
  mobileDevice,
  // web push device subscriptions + the VAPID keypair they were minted against
  pushSubscriptions,
  pushVapidKeys,
] }

export async function resetApplicationTables(): Promise<void> {
  for (const table of factoryResetTables()) await db.delete(table).run()
}
