/**
 * Composio Trigger Reconciler
 *
 * Janitor for orphaned upstream Composio subscriptions: a teardown that failed
 * (crash, cross-member 404 before SUP-765, network blip) leaves the upstream
 * subscription alive while the local trigger row is cancelled, so events pile
 * up unclaimable forever. Periodically retries the teardown for exactly those
 * subscriptions.
 *
 * Deliberately conservative: only deletes upstream subscriptions that a LOCAL
 * cancelled composio-kind row claims and no local active/paused row still
 * subscribes. Never touches subscriptions this host has no record of, so a
 * second host sharing the org cannot be broken by our reconcile pass.
 */

import { db } from '@shared/lib/db'
import { webhookTriggers, connectedAccounts } from '@shared/lib/db/schema'
import { and, eq, isNotNull } from 'drizzle-orm'
import { captureException } from '@shared/lib/error-reporting'
import { isPlatformComposioActive } from '@shared/lib/composio/client'
import { listActiveComposioTriggers, deleteComposioTrigger } from '@shared/lib/composio/triggers'
import { attribution, runWithAttribution } from '@shared/lib/platform-attribution'
import {
  getSubscribedComposioTriggerIds,
  resolvePlatformMemberForCandidates,
} from '@shared/lib/services/webhook-trigger-service'

/**
 * Delete orphaned upstream subscriptions, acting as each subscription's
 * creator member (the proxy scopes list/delete to the acting member).
 * Returns the number of upstream subscriptions deleted.
 */
export async function reconcileComposioTriggers(): Promise<number> {
  if (!isPlatformComposioActive()) return 0

  const subscribed = new Set(getSubscribedComposioTriggerIds())
  const cancelledRows = db
    .selectDistinct({
      composioTriggerId: webhookTriggers.composioTriggerId,
      mintedByMemberId: webhookTriggers.mintedByMemberId,
      createdByUserId: webhookTriggers.createdByUserId,
      ownerUserId: connectedAccounts.userId,
    })
    .from(webhookTriggers)
    .leftJoin(connectedAccounts, eq(connectedAccounts.id, webhookTriggers.connectedAccountId))
    .where(
      and(
        eq(webhookTriggers.kind, 'composio'),
        eq(webhookTriggers.status, 'cancelled'),
        isNotNull(webhookTriggers.composioTriggerId),
      ),
    )
    .all()

  // Group orphan candidates by the member we must act as (recorded minting
  // member first, then creator, then connected-account owner — same order as
  // teardown). Org tokens cannot act without a member, so unresolvable
  // candidates are skipped; the platform-side org-scoped teardown (SUP-765
  // follow-up) is the path for those.
  const byMember = new Map<string, Set<string>>()
  for (const row of cancelledRows) {
    const upstreamId = row.composioTriggerId
    if (!upstreamId || subscribed.has(upstreamId)) continue
    const resolved = resolvePlatformMemberForCandidates([row.createdByUserId, row.ownerUserId])
    const memberId =
      row.mintedByMemberId ??
      resolved?.memberId ??
      (attribution.requiresActingMember() ? null : 'local')
    if (!memberId) continue
    let ids = byMember.get(memberId)
    if (!ids) {
      ids = new Set()
      byMember.set(memberId, ids)
    }
    ids.add(upstreamId)
  }

  let deleted = 0
  for (const [memberId, candidateIds] of byMember) {
    try {
      await runWithAttribution(attribution.fromMemberId(memberId), async () => {
        // Only delete what upstream still reports live — everything else is
        // already gone and retrying would just 404.
        const upstreamIds = new Set((await listActiveComposioTriggers()).map((t) => t.id))
        for (const id of candidateIds) {
          if (!upstreamIds.has(id)) continue
          await deleteComposioTrigger(id)
          deleted++
          console.log(
            `[composio-reconcile] deleted orphaned upstream subscription ${id} (member ${memberId})`,
          )
        }
      })
    } catch (error) {
      console.warn(`[composio-reconcile] pass failed for member ${memberId}:`, error)
      captureException(error, {
        tags: { area: 'webhook-triggers', op: 'reconcile' },
        extra: { memberId },
      })
    }
  }
  return deleted
}

const INITIAL_DELAY_MS = 5 * 60 * 1000
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000

class ComposioTriggerReconciler {
  private initialTimer: NodeJS.Timeout | null = null
  private interval: NodeJS.Timeout | null = null

  /** Delayed first run so the reconcile never piles onto the startup burst. */
  start(): void {
    if (this.initialTimer || this.interval) return
    const run = () => {
      reconcileComposioTriggers().catch((error) => {
        console.error('[composio-reconcile] run failed:', error)
      })
    }
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null
      run()
      this.interval = setInterval(run, RECONCILE_INTERVAL_MS)
      this.interval.unref?.()
    }, INITIAL_DELAY_MS)
    this.initialTimer.unref?.()
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer)
      this.initialTimer = null
    }
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }
}

export const composioTriggerReconciler = new ComposioTriggerReconciler()
