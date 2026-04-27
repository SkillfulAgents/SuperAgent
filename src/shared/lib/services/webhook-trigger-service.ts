/**
 * Webhook Trigger Service
 *
 * Database operations for webhook triggers (Composio trigger subscriptions).
 * Handles creating, listing, updating, and cancelling triggers.
 */

import { db } from '@shared/lib/db'
import {
  connectedAccounts,
  webhookTriggers,
  type WebhookTrigger,
  type NewWebhookTrigger,
} from '@shared/lib/db/schema'
import { eq, and, inArray, sql, count } from 'drizzle-orm'
import { attribution, type Attribution } from '@shared/lib/attribution'
import { trackServerEvent } from '../analytics/server-analytics'
import {
  deleteComposioTrigger,
  enableComposioTrigger,
  getAvailableTriggers,
  type AvailableTrigger,
} from '@shared/lib/composio/triggers'
import { isPlatformComposioActive } from '@shared/lib/composio/client'

export type { WebhookTrigger, NewWebhookTrigger }

// ============================================================================
// Types
// ============================================================================

export interface CreateWebhookTriggerParams {
  agentSlug: string
  composioTriggerId?: string
  connectedAccountId: string
  triggerType: string
  triggerConfig?: string
  prompt: string
  name?: string
  createdBySessionId?: string
  createdByUserId?: string
}

export interface SetupWebhookTriggerParams {
  agentSlug: string
  connectedAccountId: string
  triggerType: string
  prompt: string
  name?: string
  triggerConfig?: Record<string, unknown>
  createdBySessionId?: string
  createdByUserId?: string
}

// ============================================================================
// Create Operations
// ============================================================================

export async function createWebhookTrigger(params: CreateWebhookTriggerParams): Promise<string> {
  const id = crypto.randomUUID()

  const newTrigger: NewWebhookTrigger = {
    id,
    agentSlug: params.agentSlug,
    composioTriggerId: params.composioTriggerId ?? null,
    connectedAccountId: params.connectedAccountId,
    triggerType: params.triggerType,
    triggerConfig: params.triggerConfig ?? null,
    prompt: params.prompt,
    name: params.name ?? null,
    status: 'active',
    fireCount: 0,
    createdBySessionId: params.createdBySessionId ?? null,
    createdByUserId: params.createdByUserId ?? null,
    createdAt: new Date(),
  }

  await db.insert(webhookTriggers).values(newTrigger)

  trackServerEvent('webhook_trigger_created', {
    triggerType: params.triggerType,
    agentSlug: params.agentSlug,
  })

  return id
}

// Composio buckets by connection creator; trigger setup/teardown/poll
// must all use creator's memberId (NOT agent owner).
function requireAttributionForConnection(
  connectedAccountId: string,
  ownerUserId: string | null,
): Attribution {
  const auth = attribution.fromResourceCreator(ownerUserId)
  if (!auth) {
    throw new Error(
      `Outbound auth is not configured for connected account ${connectedAccountId}`,
    )
  }
  return auth
}

async function getConnectedAccountRecord(connectedAccountId: string): Promise<{
  id: string
  composioConnectionId: string
  toolkitSlug: string
  userId: string | null
} | null> {
  const rows = await db
    .select({
      id: connectedAccounts.id,
      composioConnectionId: connectedAccounts.composioConnectionId,
      toolkitSlug: connectedAccounts.toolkitSlug,
      userId: connectedAccounts.userId,
    })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, connectedAccountId))
    .limit(1)

  return rows[0] ?? null
}

// ============================================================================
// Read Operations
// ============================================================================

export async function getWebhookTrigger(triggerId: string): Promise<WebhookTrigger | null> {
  const results = await db
    .select()
    .from(webhookTriggers)
    .where(eq(webhookTriggers.id, triggerId))

  return results[0] || null
}

export async function getWebhookTriggerByComposioId(composioTriggerId: string): Promise<WebhookTrigger | null> {
  const results = await getWebhookTriggersByComposioId(composioTriggerId)
  return results[0] || null
}

export async function getAvailableTriggersForConnectedAccount(
  connectedAccountId: string,
): Promise<{
  toolkitSlug: string
  triggers: AvailableTrigger[]
}> {
  const account = await getConnectedAccountRecord(connectedAccountId)
  if (!account) {
    throw new Error(`Connected account ${connectedAccountId} not found`)
  }

  const triggers = await getAvailableTriggers(
    account.toolkitSlug,
    requireAttributionForConnection(account.id, account.userId),
  )

  return {
    toolkitSlug: account.toolkitSlug,
    triggers,
  }
}

export async function setupWebhookTriggerForConnectedAccount(
  params: SetupWebhookTriggerParams,
): Promise<{ triggerId: string; composioTriggerId: string }> {
  const account = await getConnectedAccountRecord(params.connectedAccountId)
  if (!account) {
    throw new Error(`Connected account ${params.connectedAccountId} not found`)
  }

  const auth = requireAttributionForConnection(account.id, account.userId)
  const availableTriggers = await getAvailableTriggers(account.toolkitSlug, auth)
  const validSlugs = availableTriggers.map((trigger) => trigger.slug)
  if (!validSlugs.includes(params.triggerType)) {
    const suggestion = validSlugs.length > 0
      ? `\n\nAvailable triggers for ${account.toolkitSlug}: ${validSlugs.join(', ')}`
      : `\n\nNo triggers are available for ${account.toolkitSlug}.`
    throw new Error(`Invalid trigger type "${params.triggerType}" for this account.${suggestion}`)
  }

  const composioTriggerId = await enableComposioTrigger(
    params.triggerType,
    account.composioConnectionId,
    auth,
    params.triggerConfig,
  )

  try {
    const triggerId = await createWebhookTrigger({
      agentSlug: params.agentSlug,
      composioTriggerId,
      connectedAccountId: params.connectedAccountId,
      triggerType: params.triggerType,
      triggerConfig: params.triggerConfig ? JSON.stringify(params.triggerConfig) : undefined,
      prompt: params.prompt,
      name: params.name,
      createdBySessionId: params.createdBySessionId,
      createdByUserId: params.createdByUserId,
    })

    // TriggerManager only initialises lanes at startup; nudge it to
    // discover the new owner so events fire without a process restart.
    // Dynamic import avoids the import cycle with the scheduler module.
    void import('@shared/lib/scheduler/trigger-manager').then(({ triggerManager }) =>
      triggerManager.ensureLaneForOwner(account.userId),
    ).catch((err) => console.error('[webhook-trigger-service] ensureLaneForOwner failed:', err))

    return { triggerId, composioTriggerId }
  } catch (error) {
    await deleteComposioTrigger(composioTriggerId, auth).catch(console.error)
    throw error
  }
}

export async function getWebhookTriggersByComposioId(composioTriggerId: string): Promise<WebhookTrigger[]> {
  return db
    .select()
    .from(webhookTriggers)
    .where(
      and(
        eq(webhookTriggers.composioTriggerId, composioTriggerId),
        eq(webhookTriggers.status, 'active')
      )
    )
}

/**
 * Count triggers that retain the upstream Composio subscription (active OR paused).
 * Paused triggers must keep the subscription alive so events still arrive after resume.
 */
export async function countActiveTriggersForComposioId(composioTriggerId: string): Promise<number> {
  const [result] = await db
    .select({ value: count() })
    .from(webhookTriggers)
    .where(
      and(
        eq(webhookTriggers.composioTriggerId, composioTriggerId),
        inArray(webhookTriggers.status, ['active', 'paused'])
      )
    )
  return result.value
}

// TODO: In multi-tenant (auth) mode, callers must pass accountIds to scope results.
// Without accountIds, this returns counts across ALL accounts (fine for single-user mode).
export async function countActiveTriggersPerAccount(accountIds?: string[]): Promise<Record<string, number>> {
  const conditions = [inArray(webhookTriggers.status, ['active', 'paused'])]
  if (accountIds && accountIds.length > 0) {
    conditions.push(inArray(webhookTriggers.connectedAccountId, accountIds))
  }
  const rows = await db
    .select({
      connectedAccountId: webhookTriggers.connectedAccountId,
      count: count(),
    })
    .from(webhookTriggers)
    .where(and(...conditions))
    .groupBy(webhookTriggers.connectedAccountId)

  const counts: Record<string, number> = {}
  for (const row of rows) {
    counts[row.connectedAccountId] = row.count
  }
  return counts
}

export async function listWebhookTriggers(agentSlug: string): Promise<WebhookTrigger[]> {
  return db
    .select()
    .from(webhookTriggers)
    .where(eq(webhookTriggers.agentSlug, agentSlug))
}

// One lane per distinct connection-creator memberId; events are
// bucketed that way upstream.
export async function listWebhookTriggerAuths(): Promise<Attribution[]> {
  const rows = await db
    .select({ ownerUserId: connectedAccounts.userId })
    .from(webhookTriggers)
    .innerJoin(
      connectedAccounts,
      eq(webhookTriggers.connectedAccountId, connectedAccounts.id),
    )
    .where(inArray(webhookTriggers.status, ['active', 'paused']))

  const auths = new Map<string, Attribution>()
  for (const row of rows) {
    const auth = attribution.fromResourceCreator(row.ownerUserId)
    if (auth) {
      auths.set(auth.getKey(), auth)
    }
  }

  return [...auths.values()]
}

export async function listCancelledWebhookTriggers(agentSlug: string): Promise<WebhookTrigger[]> {
  return db
    .select()
    .from(webhookTriggers)
    .where(
      and(
        eq(webhookTriggers.agentSlug, agentSlug),
        eq(webhookTriggers.status, 'cancelled')
      )
    )
}

/**
 * List active and paused webhook triggers for an agent (i.e. everything still
 * subscribed, whether actively firing or temporarily paused).
 */
export async function listActiveWebhookTriggers(agentSlug?: string): Promise<WebhookTrigger[]> {
  if (agentSlug) {
    return db
      .select()
      .from(webhookTriggers)
      .where(
        and(
          eq(webhookTriggers.agentSlug, agentSlug),
          inArray(webhookTriggers.status, ['active', 'paused'])
        )
      )
  }
  return db
    .select()
    .from(webhookTriggers)
    .where(inArray(webhookTriggers.status, ['active', 'paused']))
}

/**
 * Batch version: list active and paused webhook triggers for multiple agents.
 */
export async function listActiveWebhookTriggersByAgents(
  agentSlugs: string[]
): Promise<Map<string, WebhookTrigger[]>> {
  if (agentSlugs.length === 0) return new Map()

  const rows = await db
    .select()
    .from(webhookTriggers)
    .where(
      and(
        inArray(webhookTriggers.agentSlug, agentSlugs),
        inArray(webhookTriggers.status, ['active', 'paused'])
      )
    )

  const result = new Map<string, WebhookTrigger[]>()
  for (const row of rows) {
    let list = result.get(row.agentSlug)
    if (!list) { list = []; result.set(row.agentSlug, list) }
    list.push(row)
  }
  return result
}

// ============================================================================
// Update Operations
// ============================================================================

export async function cancelWebhookTrigger(triggerId: string): Promise<boolean> {
  const result = await db
    .update(webhookTriggers)
    .set({
      status: 'cancelled',
      cancelledAt: new Date(),
    })
    .where(
      and(
        eq(webhookTriggers.id, triggerId),
        inArray(webhookTriggers.status, ['active', 'paused'])
      )
    )

  return (result.changes ?? 0) > 0
}

/**
 * Pause a webhook trigger. Events matching its Composio subscription will be
 * acked and discarded instead of firing the agent. The upstream Composio
 * subscription is left intact so events still arrive after resume.
 */
export async function pauseWebhookTrigger(triggerId: string): Promise<boolean> {
  const result = await db
    .update(webhookTriggers)
    .set({
      status: 'paused',
      pausedAt: new Date(),
    })
    .where(
      and(
        eq(webhookTriggers.id, triggerId),
        eq(webhookTriggers.status, 'active')
      )
    )

  return (result.changes ?? 0) > 0
}

/**
 * Resume a paused webhook trigger. New events will fire the agent again.
 */
export async function resumeWebhookTrigger(triggerId: string): Promise<boolean> {
  const result = await db
    .update(webhookTriggers)
    .set({
      status: 'active',
      pausedAt: null,
    })
    .where(
      and(
        eq(webhookTriggers.id, triggerId),
        eq(webhookTriggers.status, 'paused')
      )
    )

  return (result.changes ?? 0) > 0
}

export async function markTriggerFired(
  triggerId: string,
  sessionId: string
): Promise<void> {
  await db
    .update(webhookTriggers)
    .set({
      lastFiredAt: new Date(),
      lastSessionId: sessionId,
      fireCount: sql`${webhookTriggers.fireCount} + 1`,
    })
    .where(eq(webhookTriggers.id, triggerId))
}

export async function markTriggerFailed(triggerId: string, _error: string): Promise<void> {
  await db
    .update(webhookTriggers)
    .set({ status: 'failed' })
    .where(eq(webhookTriggers.id, triggerId))
}

/**
 * Cancel a webhook trigger locally and clean up the Composio subscription
 * if no other local triggers share the same Composio trigger ID.
 * Returns true if the trigger was cancelled, false if already cancelled/not found.
 */
export async function cancelWebhookTriggerWithCleanup(triggerId: string): Promise<boolean> {
  const trigger = await getWebhookTrigger(triggerId)
  if (!trigger) return false

  const cancelled = await cancelWebhookTrigger(triggerId)
  if (!cancelled) return false

  if (trigger.composioTriggerId && isPlatformComposioActive()) {
    const remaining = await countActiveTriggersForComposioId(trigger.composioTriggerId)
    if (remaining === 0) {
      try {
        const account = await getConnectedAccountRecord(trigger.connectedAccountId)
        if (!account) {
          throw new Error(
            `Connected account ${trigger.connectedAccountId} not found while cleaning up trigger ${triggerId}`,
          )
        }
        await deleteComposioTrigger(
          trigger.composioTriggerId,
          requireAttributionForConnection(account.id, account.userId),
        )
      } catch (error) {
        console.error('[webhook-trigger-service] Failed to delete Composio trigger:', error)
      }
    }
  }

  return true
}

export async function updateComposioTriggerId(
  triggerId: string,
  composioTriggerId: string
): Promise<void> {
  await db
    .update(webhookTriggers)
    .set({ composioTriggerId })
    .where(eq(webhookTriggers.id, triggerId))
}
