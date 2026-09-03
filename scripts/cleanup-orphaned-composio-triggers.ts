/**
 * One-time cleanup of orphaned upstream Composio subscriptions (SUP-765).
 *
 * A pre-SUP-765 cross-member teardown 404ed silently, leaving the upstream
 * subscription live while the local trigger row is cancelled — Composio keeps
 * delivering events that can never be claimed. This deletes exactly those
 * subscriptions: ones a LOCAL cancelled composio-kind row claims and no local
 * active/paused row still subscribes. Run once per affected deployment.
 *
 * Usage (against a deployment's data dir):
 *   SUPERAGENT_DB_PATH=/path/to/superagent.db npx tsx scripts/cleanup-orphaned-composio-triggers.ts
 *   npx tsx scripts/cleanup-orphaned-composio-triggers.ts --dry-run
 */
import { and, eq, isNotNull } from 'drizzle-orm'

import { db } from '../src/shared/lib/db'
import { webhookTriggers, connectedAccounts } from '../src/shared/lib/db/schema'
import { isPlatformComposioActive } from '../src/shared/lib/composio/client'
import {
  listActiveComposioTriggers,
  deleteComposioTrigger,
} from '../src/shared/lib/composio/triggers'
import { attribution, runWithAttribution } from '../src/shared/lib/platform-attribution'
import {
  getSubscribedComposioTriggerIds,
  resolvePlatformMemberForCandidates,
} from '../src/shared/lib/services/webhook-trigger-service'

const dryRun = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  if (!isPlatformComposioActive()) {
    console.log('Platform Composio inactive — nothing to reconcile.')
    return
  }

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

  // Group orphan candidates by the member to act as: recorded minting member
  // first, then creator, then connected-account owner (teardown order).
  const byMember = new Map<string, Set<string>>()
  const stillSubscribed = new Set(getSubscribedComposioTriggerIds())
  for (const row of cancelledRows) {
    const upstreamId = row.composioTriggerId
    if (!upstreamId || stillSubscribed.has(upstreamId)) continue
    const resolved = resolvePlatformMemberForCandidates([row.createdByUserId, row.ownerUserId])
    const memberId =
      row.mintedByMemberId ??
      resolved?.memberId ??
      (attribution.requiresActingMember() ? null : 'local')
    if (!memberId) {
      console.warn(`SKIP ${upstreamId}: no member resolvable in acting-member mode`)
      continue
    }
    let ids = byMember.get(memberId)
    if (!ids) {
      ids = new Set()
      byMember.set(memberId, ids)
    }
    ids.add(upstreamId)
  }

  let deleted = 0
  for (const [memberId, candidateIds] of byMember) {
    await runWithAttribution(attribution.fromMemberId(memberId), async () => {
      let upstreamIds: Set<string>
      try {
        upstreamIds = new Set((await listActiveComposioTriggers()).map((t) => t.id))
      } catch (error) {
        console.warn(`SKIP member ${memberId}: upstream list failed:`, error)
        return
      }
      for (const id of candidateIds) {
        if (!upstreamIds.has(id)) continue
        // Re-check in-use immediately before each delete: a trigger re-enabled
        // while this script runs gets the same upstream id back.
        if (new Set(getSubscribedComposioTriggerIds()).has(id)) {
          console.log(`SKIP ${id}: re-subscribed locally since scan`)
          continue
        }
        if (dryRun) {
          console.log(`DRY-RUN would delete ${id} (member ${memberId})`)
          continue
        }
        try {
          await deleteComposioTrigger(id)
          deleted++
          console.log(`DELETED orphaned upstream subscription ${id} (member ${memberId})`)
        } catch (error) {
          console.warn(`FAILED to delete ${id} (member ${memberId}):`, error)
        }
      }
    })
  }
  console.log(dryRun ? 'Dry run complete.' : `Done. Deleted ${deleted} upstream subscription(s).`)
}

main().then(() => process.exit(0), (error) => {
  console.error(error)
  process.exit(1)
})
