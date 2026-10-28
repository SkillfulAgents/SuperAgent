import { requireIntegrationReconnect } from '../../agent-integrations/lifecycle'
import { parseTaskJson } from '../schemas'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { chatIntegrations } from '../../db/schema'
import { linearConfigSchema, type LinearConfig } from './config'

export async function getLinearConfig(id: string): Promise<LinearConfig> {
  const row = await db.select().from(chatIntegrations).where(eq(chatIntegrations.id, id)).get()
  if (!row || row.provider !== 'linear') throw new Error('Linear integration not found')
  return parseTaskJson(linearConfigSchema, row.config)
}
/** Merge against the latest row so token renewal cannot overwrite settings or OAuth state. */
export async function updateLinearConfig(id: string, update: (config: LinearConfig) => LinearConfig, revokeMessage?: string): Promise<LinearConfig> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.select().from(chatIntegrations).where(and(eq(chatIntegrations.id, id), eq(chatIntegrations.provider, 'linear'))).get()
    if (!row) throw new Error('Linear integration not found')
    const current = parseTaskJson(linearConfigSchema, row.config)
    const updated = update(current)
    if (updated === current) return current
    const next = linearConfigSchema.parse(updated)
    // Both the stale-write check and per-workspace app ownership check happen
    // in the same statement, including when different processes authorize apps.
    const identityAvailable = next.identity ? sql`not exists (
      select 1 from ${chatIntegrations} as other where other.id <> ${id} and other.provider = 'linear'
      and json_extract(case when json_valid(other.config) then other.config else '{}' end, '$.identity.workspaceId') = ${next.identity.workspaceId}
      and json_extract(case when json_valid(other.config) then other.config else '{}' end, '$.identity.appUserId') = ${next.identity.appUserId}
    )` : undefined
    const changed = revokeMessage
      ? await requireIntegrationReconnect({ integrationId: id, expectedConfig: row.config, config: next, message: revokeMessage })
      : await db.update(chatIntegrations).set({ config: JSON.stringify(next), updatedAt: new Date() })
        .where(and(eq(chatIntegrations.id, id), eq(chatIntegrations.config, row.config), identityAvailable))
        .returning({ id: chatIntegrations.id }).get()
    if (changed) return next
    if (next.identity) {
      const others = await db.select().from(chatIntegrations).where(eq(chatIntegrations.provider, 'linear')).all()
      for (const other of others) {
        if (other.id === id) continue
        let identity: LinearConfig['identity']
        try { identity = parseTaskJson(linearConfigSchema, other.config).identity } catch { continue }
        if (identity?.workspaceId === next.identity.workspaceId && identity.appUserId === next.identity.appUserId) {
          throw new Error('This Linear app already belongs to another integration. Create a separate app for each agent.')
        }
      }
    }
  }
  throw new Error('Linear configuration changed concurrently. Retry the operation.')
}

/** A stale OAuth callback cannot change the lifecycle of a newer attempt. */
export async function setLinearStatusForConfig(id: string, config: LinearConfig, status: 'active' | 'disconnected', errorMessage: string | null): Promise<void> {
  await db.update(chatIntegrations).set({ status, errorMessage, updatedAt: new Date() })
    .where(and(eq(chatIntegrations.id, id), eq(chatIntegrations.config, JSON.stringify(config)))).run()
}

/** Both GraphQL and MCP revoke the same parent atomically. Stale failures cannot
 * invalidate replacement credentials or override a user's pause. */
export async function revokeLinearAuthorization(id: string, expected: { accessToken?: string; refreshToken?: string; authorizationVersion?: string }): Promise<void> {
  const message = 'Linear access expired or was revoked. Reconnect this account.'
  await updateLinearConfig(id, latest => {
    if (latest.authorizationPending || latest.authorizationVersion !== expected.authorizationVersion || !latest.tokens) return latest
    if (expected.accessToken ? latest.tokens.accessToken !== expected.accessToken
      : !expected.refreshToken || latest.tokens.refreshToken !== expected.refreshToken) return latest
    return { ...latest, tokens: undefined, authorizationError: message,
      mcp: { ...latest.mcp, available: false, checkedAt: Date.now() } }
  }, message)
}
