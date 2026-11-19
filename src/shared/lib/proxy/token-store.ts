import crypto from 'crypto'
import { db } from '@shared/lib/db'
import { agentAcl, proxyTokens } from '@shared/lib/db/schema'
import { and, asc, eq, sql } from 'drizzle-orm'

export async function getOrCreateProxyToken(agentSlug: string): Promise<string> {
  const existing = await db
    .select()
    .from(proxyTokens)
    .where(eq(proxyTokens.agentSlug, agentSlug))
    .limit(1)

  if (existing.length > 0) {
    return existing[0].token
  }

  const token = `synth_${crypto.randomBytes(32).toString('hex')}`
  await db.insert(proxyTokens).values({
    id: crypto.randomUUID(),
    agentSlug,
    token,
    createdAt: new Date(),
  })

  return token
}

export async function validateProxyToken(token: string): Promise<string | null> {
  const result = await db
    .select()
    .from(proxyTokens)
    .where(eq(proxyTokens.token, token))
    .limit(1)

  return result.length > 0 ? result[0].agentSlug : null
}

/**
 * `validateProxyToken` and `getAgentOwnerUserId` (auth mode's `agent_acl`) in one statement: the
 * token's agent, and that agent's first owner by `createdAt`, or null when it has none. Null for
 * an unknown token. The owner is the acting member on billed proxy calls, so the order matters.
 */
export async function validateProxyTokenWithOwner(token: string): Promise<{ agentSlug: string; ownerUserId: string | null } | null> {
  const firstOwner = db
    .select({ userId: agentAcl.userId })
    .from(agentAcl)
    .where(and(eq(agentAcl.agentSlug, proxyTokens.agentSlug), eq(agentAcl.role, 'owner')))
    .orderBy(asc(agentAcl.createdAt))
    .limit(1)
  const rows = await db
    .select({ agentSlug: proxyTokens.agentSlug, ownerUserId: sql<string | null>`(${firstOwner})` })
    .from(proxyTokens)
    .where(eq(proxyTokens.token, token))
    .limit(1)
    .all()
  return rows[0] ?? null
}

export async function revokeProxyToken(agentSlug: string): Promise<void> {
  await db.delete(proxyTokens).where(eq(proxyTokens.agentSlug, agentSlug))
}
