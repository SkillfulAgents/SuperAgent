import { parseTaskJson } from '../schemas'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../db'
import { chatIntegrations } from '../../db/schema'
import { linearConfigSchema, type LinearConfig } from './config'

export function getLinearConfig(id: string): LinearConfig {
  const row = db.select().from(chatIntegrations).where(eq(chatIntegrations.id, id)).get()
  if (!row || row.provider !== 'linear') throw new Error('Linear integration not found')
  return parseTaskJson(linearConfigSchema, row.config)
}
/** Merge against the latest row so token renewal cannot overwrite settings or OAuth state. */
export function updateLinearConfig(id: string, update: (config: LinearConfig) => LinearConfig): LinearConfig {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = db.select().from(chatIntegrations).where(and(eq(chatIntegrations.id, id), eq(chatIntegrations.provider, 'linear'))).get()
    if (!row) throw new Error('Linear integration not found')
    const next = linearConfigSchema.parse(update(parseTaskJson(linearConfigSchema, row.config)))
    // Both the stale-write check and per-workspace app ownership check happen
    // in the same statement, including when different processes authorize apps.
    const identityAvailable = next.identity ? sql`not exists (
      select 1 from ${chatIntegrations} as other where other.id <> ${id} and other.provider = 'linear'
      and json_extract(other.config, '$.identity.workspaceId') = ${next.identity.workspaceId}
      and json_extract(other.config, '$.identity.appUserId') = ${next.identity.appUserId}
    )` : undefined
    const changed = db.update(chatIntegrations).set({ config: JSON.stringify(next), updatedAt: new Date() })
      .where(and(eq(chatIntegrations.id, id), eq(chatIntegrations.config, row.config), identityAvailable))
      .returning({ id: chatIntegrations.id }).get()
    if (changed) return next
    if (next.identity) {
      const others = db.select().from(chatIntegrations).where(eq(chatIntegrations.provider, 'linear')).all()
      for (const other of others) {
        if (other.id === id) continue
        const identity = parseTaskJson(linearConfigSchema, other.config).identity
        if (identity?.workspaceId === next.identity.workspaceId && identity.appUserId === next.identity.appUserId) {
          throw new Error('This Linear app already belongs to another integration. Create a separate app for each agent.')
        }
      }
    }
  }
  throw new Error('Linear configuration changed concurrently. Retry the operation.')
}
