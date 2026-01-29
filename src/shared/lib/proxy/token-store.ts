import crypto from 'crypto'
import { db } from '@shared/lib/db'
import { proxyTokens } from '@shared/lib/db/schema'
import { eq } from 'drizzle-orm'

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

export async function revokeProxyToken(agentSlug: string): Promise<void> {
  await db.delete(proxyTokens).where(eq(proxyTokens.agentSlug, agentSlug))
}
