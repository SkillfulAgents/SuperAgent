import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { llmConnections } from '../db/schema'
import { changesOf } from '../db/batch'
import { connectionConfigSchema, parseConnectionJson } from './connection-schema'
import { refreshGrokCredential } from './grok-oauth'

/** The app owns refresh. A generation/config CAS prevents a late exchange from
 * overwriting reconnects, edits or deletion. The DB lease also covers workers.
 */
export async function resolveConnectionCredential(id: string, rejectedGeneration?: number) {
  const deadline = Date.now() + 65_000
  while (Date.now() < deadline) {
    const row = await db.select().from(llmConnections).where(eq(llmConnections.id, id)).get()
    if (!row) throw new Error('LLM provider no longer exists')
    const config = parseConnectionJson(connectionConfigSchema, row.config)
    const oauth = config.oauth
    if (!oauth) throw new Error('Reconnect this provider in Settings → Model Providers')
    if (oauth.expiresAt > Date.now() + 30_000 && rejectedGeneration !== row.generation) {
      return { ...oauth, generation: row.generation }
    }
    if (oauth.refreshLease && oauth.refreshLease.expiresAt > Date.now()) {
      await new Promise(resolve => setTimeout(resolve, 150))
      continue
    }
    const claimed = connectionConfigSchema.parse({ ...config, oauth: { ...oauth, refreshLease: { id: randomUUID(), expiresAt: Date.now() + 60_000 } } })
    const claimedJson = JSON.stringify(claimed)
    const lease = await db.update(llmConnections).set({ config: claimedJson })
      .where(and(eq(llmConnections.id, id), eq(llmConnections.config, row.config), eq(llmConnections.generation, row.generation))).run()
    if (!changesOf(lease)) continue
    try {
      if (row.provider !== 'grok-subscription') throw new Error('This provider cannot refresh credentials')
      const next = await refreshGrokCredential(oauth)
      const saved = await db.update(llmConnections).set({
        config: JSON.stringify(connectionConfigSchema.parse({ ...config, oauth: next })),
        generation: sql`${llmConnections.generation} + 1`, updatedAt: new Date(),
      }).where(and(eq(llmConnections.id, id), eq(llmConnections.config, claimedJson), eq(llmConnections.generation, row.generation))).run()
      if (changesOf(saved)) return { ...next, generation: row.generation + 1 }
      // A reconnect/edit won. Re-read; never resurrect this exchange's tokens.
    } catch (error) {
      await db.update(llmConnections).set({ config: row.config })
        .where(and(eq(llmConnections.id, id), eq(llmConnections.config, claimedJson), eq(llmConnections.generation, row.generation))).run()
      throw error
    }
  }
  throw new Error('Provider sign-in refresh is busy. Please retry.')
}
