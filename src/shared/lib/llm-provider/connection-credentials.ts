import { parseConnectionJson } from './connection-schema'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { db } from '../db'
import { llmConnections } from '../db/schema'
import { changesOf } from '../db/batch'
import { getConnection, providerForConnection } from './connections'
import { connectionCredentialsSchema, type ConnectionCredentials } from './connection-schema'

export interface AccessCredential {
  accessToken: string
  expiresAt?: number
  generation: number
}
export type CredentialRefresher = (
  credentials: ConnectionCredentials,
  signal: AbortSignal
) => Promise<ConnectionCredentials>
const refreshers = new Map<string, CredentialRefresher>()

/** Provider adapters register their exchange in the app, never the container. */
export function registerCredentialRefresher(provider: string, refresh: CredentialRefresher): void {
  refreshers.set(provider, refresh)
}

/** Reconnect/rotation invalidates an outstanding exchange atomically. */
export async function replaceConnectionCredentials(
  id: string,
  raw: ConnectionCredentials
): Promise<void> {
  const credentials = connectionCredentialsSchema.parse(raw)
  for (;;) {
    const row = await getConnection(id)
    if (!row) throw new Error('Connection no longer exists')
    const changed = await db
      .update(llmConnections)
      .set({
        credentials: JSON.stringify(credentials),
        generation: row.generation + 1,
        state: 'ready',
        refreshLease: null,
        refreshLeaseUntil: null,
        updatedAt: new Date(),
      })
      .where(and(eq(llmConnections.id, id), eq(llmConnections.generation, row.generation)))
      .run()
    if (changesOf(changed)) return
  }
}

/** DB compare-and-set lease coalesces refresh across app processes. Only the
 * access token leaves this service. A late rejection of an older generation
 * reads the persisted new token without consuming another refresh token.
 */
export async function getAccessCredential(
  id: string,
  rejectedGeneration?: number
): Promise<AccessCredential> {
  const deadline = Date.now() + 65_000
  for (;;) {
    const row = await getConnection(id)
    if (!row) throw new Error('Connection no longer exists')
    if (row.state === 'reconnect') throw new Error('Reconnect this LLM connection')
    const credentials = row.credentials
      ? parseConnectionJson(connectionCredentialsSchema, row.credentials)
      : null
    if (!credentials) {
      const accessToken = providerForConnection(row).getEffectiveApiKey()
      if (!accessToken) throw new Error('Connection credentials are not configured')
      return { accessToken, generation: row.generation }
    }
    const expired =
      credentials.expiresAt !== undefined && credentials.expiresAt < Date.now() + 60_000
    const rejected = rejectedGeneration !== undefined && rejectedGeneration === row.generation
    if (!expired && !rejected)
      return {
        accessToken: credentials.accessToken,
        expiresAt: credentials.expiresAt,
        generation: row.generation,
      }
    const refresh = refreshers.get(row.provider)
    if (!refresh || !credentials.refreshToken) throw new Error('Reconnect this LLM connection')
    if (Date.now() > deadline) throw new Error('Timed out waiting for credential refresh')
    const lease = randomUUID()
    const acquired = await db
      .update(llmConnections)
      .set({ refreshLease: lease, refreshLeaseUntil: Date.now() + 60_000 })
      .where(
        and(
          eq(llmConnections.id, id),
          eq(llmConnections.generation, row.generation),
          or(isNull(llmConnections.refreshLease), lt(llmConnections.refreshLeaseUntil, Date.now()))
        )
      )
      .run()
    if (!changesOf(acquired)) {
      await delay(50)
      continue
    }
    const ownsLease = and(
      eq(llmConnections.id, id),
      eq(llmConnections.generation, row.generation),
      eq(llmConnections.refreshLease, lease)
    )
    try {
      const signal = AbortSignal.timeout(45_000)
      const next = connectionCredentialsSchema.parse(
        await Promise.race([
          refresh(credentials, signal),
          new Promise<never>((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          ),
        ])
      )
      signal.throwIfAborted()
      await db
        .update(llmConnections)
        .set({
          credentials: JSON.stringify(next),
          generation: row.generation + 1,
          state: 'ready',
          refreshLease: null,
          refreshLeaseUntil: null,
          updatedAt: new Date(),
        })
        .where(ownsLease)
        .run()
      // Re-read even after losing the lease: reconnect/deletion may have won.
    } catch {
      const failed = await db
        .update(llmConnections)
        .set({ state: 'reconnect', refreshLease: null, refreshLeaseUntil: null })
        .where(ownsLease)
        .run()
      if (changesOf(failed))
        throw new Error('Credential refresh failed. Reconnect this LLM connection')
    }
  }
}
