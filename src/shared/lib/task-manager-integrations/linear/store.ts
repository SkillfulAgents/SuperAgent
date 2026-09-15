import { parseTaskJson } from '../schemas'
import { eq } from 'drizzle-orm'
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
  return db.transaction(() => {
    const next = linearConfigSchema.parse(update(getLinearConfig(id)))
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
    db.update(chatIntegrations).set({ config: JSON.stringify(next), updatedAt: new Date() }).where(eq(chatIntegrations.id, id)).run()
    return next
  })
}
