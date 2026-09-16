/**
 * Webhook Trigger Service
 *
 * Database operations for webhook triggers (Composio trigger subscriptions).
 * Handles creating, listing, updating, and cancelling triggers.
 */

import { db } from '@shared/lib/db'
import {
  webhookTriggers,
  connectedAccounts,
  authAccount,
  type WebhookTrigger,
  type NewWebhookTrigger,
} from '@shared/lib/db/schema'
import { eq, and, inArray, isNotNull, sql, count, desc } from 'drizzle-orm'
import { captureException, captureMessage } from '@shared/lib/error-reporting'
import { trackServerEvent } from '../analytics/server-analytics'
import { deleteComposioTrigger } from '@shared/lib/composio/triggers'
import { isPlatformComposioActive } from '@shared/lib/composio/client'
import { attribution, runWithAttribution } from '@shared/lib/platform-attribution'
import { disablePlatformWebhookEndpoint } from '@shared/lib/services/webhook-endpoints-client'
import { getPlatformAccessToken, getStoredPlatformMemberId } from '@shared/lib/services/platform-auth-service'

const PLATFORM_PROVIDER_ID = 'platform'

function lookupPlatformMemberId(userId: string): string | null {
  const rows = db
    .select({ accountId: authAccount.accountId })
    .from(authAccount)
    .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, PLATFORM_PROVIDER_ID)))
    .orderBy(desc(authAccount.updatedAt))
    .limit(1)
    .all()
  return rows[0]?.accountId ?? null
}

/**
 * Resolve the platform member ID for an ordered list of candidate user IDs,
 * preferring earlier candidates. Returns the first candidate that resolves to a
 * platform `authAccount` row (and the user ID it resolved from), or null if none
 * do. Null/duplicate candidates are skipped.
 *
 * Used by both the poller (which member to claim events under) and runtime
 * attribution (which user to run the session as) so the two never diverge: the
 * trigger creator is preferred, but the connected-account owner is a fallback
 * when the creator has no platform member (SUP-226).
 */
export function resolvePlatformMemberForCandidates(
  candidates: Array<string | null | undefined>,
): { userId: string; memberId: string } | null {
  const seen = new Set<string>()
  for (const userId of candidates) {
    if (!userId || seen.has(userId)) continue
    seen.add(userId)
    const memberId = lookupPlatformMemberId(userId)
    if (memberId) return { userId, memberId }
  }
  return null
}

/** Distinct member IDs of active/paused trigger owners; used by TriggerManager to poll per-member. */
export function getDistinctPlatformMemberIdsForActiveTriggers(): string[] {
  const rows = db
    .select({
      mintedByMemberId: webhookTriggers.mintedByMemberId,
      createdByUserId: webhookTriggers.createdByUserId,
      ownerUserId: connectedAccounts.userId,
    })
    .from(webhookTriggers)
    .leftJoin(connectedAccounts, eq(connectedAccounts.id, webhookTriggers.connectedAccountId))
    .where(inArray(webhookTriggers.status, ['active', 'paused']))
    .all()

  const ids = new Set<string>()
  for (const row of rows) {
    // The recorded minting member is the one the proxy scopes the subscription
    // (and its events) to, so it leads the poll set (SUP-765). It does not
    // replace the fallbacks below: if that member has since left the org their
    // poll throws and the loop only logs it, so without the other candidates the
    // trigger would silently stop firing forever. Duplicates collapse in the Set.
    if (row.mintedByMemberId) ids.add(row.mintedByMemberId)
    // Prefer the creator, but fall back to the connected-account owner when the
    // creator has no platform member — otherwise the trigger is silently dropped
    // from the poll set even though the owner could claim its events (SUP-226).
    const resolved = resolvePlatformMemberForCandidates([row.createdByUserId, row.ownerUserId])
    if (resolved) {
      ids.add(resolved.memberId)
      continue
    }
    // Triggers minted from automated sessions have no creator, and custom
    // endpoints have no connected account. The mint fell back to the stored
    // member, so poll as that member too — otherwise the trigger never fires
    // in acting-member mode.
    const stored = getStoredPlatformMemberId()
    if (stored) ids.add(stored)
  }
  return [...ids]
}

// Active composio trigger IDs registered on this host (no per-member filter — the access key / acting member is the auth boundary at the proxy).
export function getActiveComposioTriggerIds(): string[] {
  return db
    .select({ composioTriggerId: webhookTriggers.composioTriggerId })
    .from(webhookTriggers)
    .where(
      and(
        eq(webhookTriggers.status, 'active'),
        isNotNull(webhookTriggers.composioTriggerId),
      ),
    )
    .all()
    .map((r) => r.composioTriggerId!)
}

/**
 * Distinct composio trigger IDs that still hold an upstream subscription
 * (status IN 'active'/'paused'), mirroring countActiveTriggersForComposioId /
 * listActiveWebhookTriggers. Used to scope the platform poll so paused-period
 * events are still claimed: TriggerManager finds no *active* local trigger and
 * acks/discards them, instead of letting them accumulate pending and fire a
 * session on resume (SUP-225).
 */
export function getSubscribedComposioTriggerIds(): string[] {
  const ids = db
    .selectDistinct({ composioTriggerId: webhookTriggers.composioTriggerId })
    .from(webhookTriggers)
    .where(
      and(
        inArray(webhookTriggers.status, ['active', 'paused']),
        isNotNull(webhookTriggers.composioTriggerId),
      ),
    )
    .all()
    .map((r) => r.composioTriggerId!)
  return ids
}

export type { WebhookTrigger, NewWebhookTrigger }

// ============================================================================
// Types
// ============================================================================

export interface CreateWebhookTriggerParams {
  agentSlug: string
  /** 'composio' (default) or 'custom' (agent-minted platform webhook endpoint). */
  kind?: 'composio' | 'custom'
  /** For kind='custom' this carries the platform endpoint id ("whep_..."). */
  composioTriggerId?: string
  /** Required for Composio triggers; absent for custom endpoints. */
  connectedAccountId?: string
  triggerType: string
  triggerConfig?: string
  prompt: string
  name?: string
  createdBySessionId?: string
  createdByUserId?: string
  /** Acting platform member the upstream subscription was minted under (SUP-765). */
  mintedByMemberId?: string
  model?: string
  effort?: string
  speed?: string
}

// ============================================================================
// Create Operations
// ============================================================================

export async function createWebhookTrigger(params: CreateWebhookTriggerParams): Promise<string> {
  const id = crypto.randomUUID()

  const newTrigger: NewWebhookTrigger = {
    id,
    agentSlug: params.agentSlug,
    kind: params.kind ?? 'composio',
    composioTriggerId: params.composioTriggerId ?? null,
    connectedAccountId: params.connectedAccountId ?? null,
    triggerType: params.triggerType,
    triggerConfig: params.triggerConfig ?? null,
    prompt: params.prompt,
    name: params.name ?? null,
    status: 'active',
    fireCount: 0,
    createdBySessionId: params.createdBySessionId ?? null,
    createdByUserId: params.createdByUserId ?? null,
    mintedByMemberId: params.mintedByMemberId ?? null,
    model: params.model ?? null,
    effort: params.effort ?? null,
    speed: params.speed ?? null,
    createdAt: new Date(),
  }

  await db.insert(webhookTriggers).values(newTrigger)

  trackServerEvent('webhook_trigger_created', {
    triggerType: params.triggerType,
    agentSlug: params.agentSlug,
  })

  // Cold-start fix: a host that booted with 0 active triggers never
  // subscribed Realtime. Lazy import avoids the circular dep.
  // Best-effort: catch so a late rejection can't reach the process-level
  // unhandledRejection handler (fatal in Electron main) or outlive a test.
  // The success log is the only positive signal this fire-and-forget path ran;
  // webhook-trigger-service.coldstart.test.ts asserts on it.
  void import('@shared/lib/scheduler/trigger-manager')
    .then(async ({ triggerManager }) => {
      if (!triggerManager.isRealtimeActive()) {
        await triggerManager.pollAndProcess()
      }
      console.log(`[webhook-triggers] cold-start nudge completed for trigger ${id}`)
    })
    .catch((err) => {
      console.warn('[webhook-triggers] cold-start poll skipped:', err)
    })

  return id
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
    if (row.connectedAccountId) counts[row.connectedAccountId] = row.count
  }
  return counts
}

export async function listWebhookTriggers(agentSlug: string): Promise<WebhookTrigger[]> {
  return db
    .select()
    .from(webhookTriggers)
    .where(eq(webhookTriggers.agentSlug, agentSlug))
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
 * Cancel a webhook trigger locally and clean up the upstream subscription if
 * no other local triggers share the same upstream id ("last one out"):
 * Composio triggers delete the Composio subscription; custom triggers disable
 * the platform webhook endpoint (ingest starts 404ing at the edge).
 * Returns true if the trigger was cancelled, false if already cancelled/not found.
 */
export async function cancelWebhookTriggerWithCleanup(
  triggerId: string,
  // When set, the trigger must belong to this agent or the cancel is refused.
  // The agent-facing cancel_trigger tool passes it so agent A can't tear down
  // (and disable the public endpoint of) agent B's trigger by id; internal
  // cleanup callers (account/agent deletion) omit it.
  expectedAgentSlug?: string,
): Promise<boolean> {
  const trigger = await getWebhookTrigger(triggerId)
  if (!trigger) return false
  if (expectedAgentSlug !== undefined && trigger.agentSlug !== expectedAgentSlug) return false

  const cancelled = await cancelWebhookTrigger(triggerId)
  if (!cancelled) return false

  if (trigger.composioTriggerId && canReachUpstream(trigger.kind)) {
    const upstreamId = trigger.composioTriggerId
    const remaining = await countActiveTriggersForComposioId(upstreamId)
    if (remaining === 0) {
      try {
        await tearDownUpstream(trigger, upstreamId)
      } catch (error) {
        console.error('[webhook-trigger-service] Failed to tear down upstream subscription:', error)
        // Silent to the user: the trigger row is already cancelled, but the
        // upstream (a live PUBLIC webhook URL for custom kind) is still up.
        // Capture so an orphaned endpoint is diagnosable. Never attach the
        // secret/URL — the upstream id is enough to reconcile.
        captureException(error, {
          tags: { area: 'webhook-endpoints', op: 'disable' },
          extra: {
            triggerId,
            agentSlug: trigger.agentSlug,
            upstreamId,
            kind: trigger.kind,
          },
        })
      }
    }
  }

  return true
}

// Custom endpoints live on the platform proxy regardless of Composio key mode,
// so gate on platform auth or a user-supplied Composio key leaves the URL live.
function canReachUpstream(kind: WebhookTrigger['kind']): boolean {
  return kind === 'custom' ? Boolean(getPlatformAccessToken()) : isPlatformComposioActive()
}

// One place that speaks both upstream vocabularies (platform endpoint disable
// vs Composio subscription delete). Callers own attribution.
async function deleteUpstream(
  kind: WebhookTrigger['kind'],
  memberId: string,
  upstreamId: string,
): Promise<void> {
  if (kind === 'custom') await disablePlatformWebhookEndpoint(memberId, upstreamId)
  else await deleteComposioTrigger(upstreamId)
}

// Duck-typed so a new upstream client can't silently regress to perpetual retries.
function isUpstreamNotFound(error: unknown): boolean {
  return error instanceof Error && (error as { statusCode?: unknown }).statusCode === 404
}

// The proxy 404s a cross-member DELETE exactly like a missing subscription, so
// a 404 under a guessed member proves nothing. Thrown so the orphan is reported.
export class UpstreamOwnerUnresolvedError extends Error {
  constructor(
    public readonly upstreamId: string,
    public readonly triedMemberIds: string[],
  ) {
    super(
      `Upstream ${upstreamId} not found under any candidate member (${triedMemberIds.join(', ') || 'none'}); owner unknown`,
    )
    this.name = 'UpstreamOwnerUnresolvedError'
  }
}

export interface TeardownMembers {
  /** Members that may own the upstream, best guess first. Empty = ambient. */
  memberIds: string[]
  /** True when the first entry is the recorded minting member, or the proxy ignores members. */
  known: boolean
}

// Minting member when recorded (the only guaranteed principal); pre-column rows
// guess via the SUP-226 chain (creator, owner) then the stored member.
export function resolveTeardownMembers(trigger: WebhookTrigger): TeardownMembers {
  if (!attribution.requiresActingMember()) return { memberIds: [], known: true }
  if (trigger.mintedByMemberId) return { memberIds: [trigger.mintedByMemberId], known: true }
  const candidates = [
    resolvePlatformMemberForCandidates([trigger.createdByUserId])?.memberId,
    resolvePlatformMemberForCandidates([getConnectedAccountOwnerUserId(trigger.connectedAccountId)])?.memberId,
    getStoredPlatformMemberId(),
  ]
  return { memberIds: [...new Set(candidates.filter((m): m is string => Boolean(m)))], known: false }
}

// Delete as the minting member via ALS (the interceptor overrides explicit auth).
// 404 = gone only for a known member; guessed members are tried in turn, all-404 throws.
async function tearDownUpstream(trigger: WebhookTrigger, upstreamId: string): Promise<void> {
  const { memberIds, known } = resolveTeardownMembers(trigger)
  const attempts: Array<string | null> = memberIds.length > 0 ? memberIds : [null]
  for (const memberId of attempts) {
    try {
      await runWithAttribution(memberId ? attribution.fromMemberId(memberId) : null, () =>
        deleteUpstream(trigger.kind, memberId ?? getStoredPlatformMemberId() ?? 'local', upstreamId),
      )
      return
    } catch (error) {
      if (!isUpstreamNotFound(error)) throw error
    }
  }
  if (known) {
    // Normally "already gone" — but a recorded minter who has since left the org
    // 404s identically while the subscription stays live, which is the SUP-765
    // failure mode itself. Report it so that orphan is at least diagnosable.
    // Ambient teardown (no members) is exempt: there the proxy ignores members,
    // so a 404 really does mean gone.
    if (memberIds.length > 0) {
      console.warn(
        `[WebhookTriggerService] Upstream ${upstreamId} 404'd under its recorded minting member ${memberIds[0]} — already deleted, or that member left the org and the subscription is orphaned`,
      )
      captureMessage('Upstream teardown 404 under the recorded minting member', {
        level: 'info',
        tags: { area: 'webhook-triggers', op: 'teardown-known-404', kind: trigger.kind },
        extra: { triggerId: trigger.id, agentSlug: trigger.agentSlug, upstreamId, memberId: memberIds[0] },
      })
    }
    return
  }
  throw new UpstreamOwnerUnresolvedError(upstreamId, memberIds)
}

// SUP-226 candidate order (creator, then connected-account owner), shared by
// polling and session attribution so the two chains cannot drift.
export function resolveTriggerPrincipal(
  trigger: Pick<WebhookTrigger, 'createdByUserId' | 'connectedAccountId'>,
): { userId: string; memberId: string } | null {
  return resolvePlatformMemberForCandidates([
    trigger.createdByUserId,
    getConnectedAccountOwnerUserId(trigger.connectedAccountId),
  ])
}

export function getConnectedAccountOwnerUserId(connectedAccountId: string | null): string | null {
  if (!connectedAccountId) return null
  const rows = db
    .select({ userId: connectedAccounts.userId })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.id, connectedAccountId))
    .limit(1)
    .all()
  return rows[0]?.userId ?? null
}

/**
 * Cancel every active/paused webhook trigger bound to a connected account and
 * clean up each one's upstream Composio subscription.
 *
 * Used when a connected account is deleted: the trigger rows reference the
 * account by id with no DB-level FK/cascade, so without this they would be left
 * status='active' and keep feeding `getActiveComposioTriggerIds()` (and thus the
 * live upstream subscription) even though the account/auth is gone (SUP-221).
 *
 * Must be invoked BEFORE the account row is deleted, while the account/auth is
 * still present, so cancelWebhookTriggerWithCleanup can tear down the upstream
 * Composio subscription when no sibling active trigger shares the
 * composioTriggerId.
 */
export async function cancelTriggersForConnectedAccount(connectedAccountId: string): Promise<void> {
  const triggers = await db
    .select({ id: webhookTriggers.id })
    .from(webhookTriggers)
    .where(
      and(
        eq(webhookTriggers.connectedAccountId, connectedAccountId),
        inArray(webhookTriggers.status, ['active', 'paused'])
      )
    )

  for (const { id } of triggers) {
    await cancelWebhookTriggerWithCleanup(id)
  }
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

/**
 * Update a webhook trigger's prompt (the instructions sent when the trigger fires).
 * Allowed in any non-cancelled state.
 */
export async function updateWebhookTriggerPrompt(
  triggerId: string,
  prompt: string,
): Promise<boolean> {
  const trigger = await getWebhookTrigger(triggerId)
  if (!trigger || trigger.status === 'cancelled') return false

  const result = await db
    .update(webhookTriggers)
    .set({ prompt })
    .where(eq(webhookTriggers.id, triggerId))

  return (result.changes ?? 0) > 0
}

export async function updateWebhookTriggerName(
  triggerId: string,
  name: string,
): Promise<boolean> {
  const trigger = await getWebhookTrigger(triggerId)
  if (!trigger || trigger.status === 'cancelled') return false

  const result = await db
    .update(webhookTriggers)
    .set({ name })
    .where(eq(webhookTriggers.id, triggerId))

  return (result.changes ?? 0) > 0
}

/**
 * Update a webhook trigger's runtime options (model, effort, and/or speed).
 * Pass null to clear a field back to the global default.
 */
export async function updateWebhookTriggerRuntimeOptions(
  triggerId: string,
  options: { model?: string | null; effort?: string | null; speed?: string | null },
): Promise<boolean> {
  const trigger = await getWebhookTrigger(triggerId)
  if (!trigger || trigger.status === 'cancelled') return false

  const updates: Record<string, string | null> = {}
  if ('model' in options) updates.model = options.model ?? null
  if ('effort' in options) updates.effort = options.effort ?? null
  if ('speed' in options) updates.speed = options.speed ?? null

  const result = await db
    .update(webhookTriggers)
    .set(updates)
    .where(eq(webhookTriggers.id, triggerId))

  return (result.changes ?? 0) > 0
}
