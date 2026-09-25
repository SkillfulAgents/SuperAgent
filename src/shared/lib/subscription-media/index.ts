import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db'
import { llmConnections } from '../db/schema'
import { getAgentOwnerUserId } from '../services/agent-owner'
import { SUBSCRIPTION_MEDIA_PROVIDERS } from './registry'
import type { SubscriptionMediaProvider } from './types'

export { MediaRequestError, type GeneratedMedia, type SubscriptionMediaProvider } from './types'

export function mediaProvider(id: string): SubscriptionMediaProvider | undefined {
  return SUBSCRIPTION_MEDIA_PROVIDERS.find(provider => provider.id === id)
}

// Same visibility as canSelectConnection: shared connections plus the owner's own.
function selectableBy(ownerUserId: string | null) {
  return ownerUserId
    ? or(isNull(llmConnections.userId), eq(llmConnections.userId, ownerUserId))
    : isNull(llmConnections.userId)
}

/** The account that pays for a request: the owner's own connection before a
 * shared one, oldest first, so the choice is stable across calls. */
export async function mediaConnectionId(provider: SubscriptionMediaProvider, agentSlug: string): Promise<string | undefined> {
  const [row] = await db.select({ id: llmConnections.id }).from(llmConnections)
    .where(and(eq(llmConnections.provider, provider.llmProviderId), selectableBy(await getAgentOwnerUserId(agentSlug))))
    .orderBy(sql`${llmConnections.userId} is null`, asc(llmConnections.createdAt))
    .limit(1)
    .all()
  return row?.id
}

export async function subscriptionMediaPromptHints(agentSlug: string): Promise<string[]> {
  if (SUBSCRIPTION_MEDIA_PROVIDERS.length === 0) return []
  const rows = await db.selectDistinct({ provider: llmConnections.provider }).from(llmConnections)
    .where(and(
      inArray(llmConnections.provider, SUBSCRIPTION_MEDIA_PROVIDERS.map(provider => provider.llmProviderId)),
      selectableBy(await getAgentOwnerUserId(agentSlug)),
    ))
    .all()
  const connected = new Set(rows.map(row => row.provider))
  return SUBSCRIPTION_MEDIA_PROVIDERS.filter(provider => connected.has(provider.llmProviderId))
    .map(provider => provider.extraPrompt)
}
