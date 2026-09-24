import { CredentialRefreshError } from '../../../../agent-container/src/credential-refresh-error'
import { refreshCodexCredential } from './codex-oauth'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { llmConnections } from '../db/schema'
import { changesOf } from '../db/batch'
import { connectionConfigSchema, parseConnectionJson } from './connection-schema'
import { refreshGrokCredential } from './grok-oauth'
import { refreshKimiCredential } from './kimi-oauth'
import type { OAuthCredential } from './oauth-schema'
import { isOAuthProvider, type OAuthProvider } from './provider-types'

const refreshers: Record<OAuthProvider, (previous: OAuthCredential) => Promise<OAuthCredential>> = {
  'grok-subscription': refreshGrokCredential,
  'codex-subscription': refreshCodexCredential,
  'kimi-subscription': refreshKimiCredential,
}

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
    if (oauth.refreshFailure && (oauth.refreshFailure.reconnectRequired || oauth.refreshFailure.retryAt > Date.now())) {
      throw new CredentialRefreshError(oauth.refreshFailure.reconnectRequired ? 401 : 503)
    }
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
      if (!isOAuthProvider(row.provider)) throw new Error('This provider cannot refresh credentials')
      const next = await refreshers[row.provider](oauth)
      const saved = await db.update(llmConnections).set({
        config: JSON.stringify(connectionConfigSchema.parse({ ...config, oauth: next })),
        generation: sql`${llmConnections.generation} + 1`, updatedAt: new Date(),
      }).where(and(eq(llmConnections.id, id), eq(llmConnections.config, claimedJson), eq(llmConnections.generation, row.generation))).run()
      if (changesOf(saved)) return { ...next, generation: row.generation + 1 }
      // A reconnect/edit won. Re-read; never resurrect this exchange's tokens.
    } catch (error) {
      const safe = error instanceof CredentialRefreshError ? error : new CredentialRefreshError()
      const failed = connectionConfigSchema.parse({ ...config, oauth: { ...oauth, refreshLease: undefined,
        refreshFailure: { reconnectRequired: safe.status === 401, retryAt: Date.now() + 30_000 } } })
      const savedFailure = await db.update(llmConnections).set({ config: JSON.stringify(failed) })
        .where(and(eq(llmConnections.id, id), eq(llmConnections.config, claimedJson), eq(llmConnections.generation, row.generation))).run()
      if (!changesOf(savedFailure)) continue // A reconnect/deletion won; inspect its state.
      throw safe
    }
  }
  throw new Error('Provider sign-in refresh is busy. Please retry.')
}

/** An ordinary edit must not discard a rotated pair by overwriting its lease.
 * Reconnects bypass this wait and replace the old credentials deliberately.
 */
export async function waitForConnectionRefresh(id: string): Promise<void> {
  const deadline = Date.now() + 65_000
  while (Date.now() < deadline) {
    const row = await db.select().from(llmConnections).where(eq(llmConnections.id, id)).get()
    const lease = row && parseConnectionJson(connectionConfigSchema, row.config).oauth?.refreshLease
    if (!lease || lease.expiresAt <= Date.now()) return
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('Provider sign-in refresh is busy. Please retry.')
}
