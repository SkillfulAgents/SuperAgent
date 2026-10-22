/**
 * Session wake delivery — the single path that resumes a sleeping session,
 * shared by the scheduler's wake branch and the manual "Wake now" route.
 *
 * A per-task claim, a lock the task's agent holds, makes check-status → send
 * → record a critical section: a scheduler poll and a "Wake now" click landing
 * simultaneously can never both deliver. The claim is taken before delivery
 * and the task status is re-read under it, while the durable status flip
 * (markTaskExecuted) stays AFTER the send — a crash between send and record is
 * caught by the lastWake metadata guard on the next attempt, and a crash
 * before the send loses nothing.
 */

import { agentRegistry } from '@shared/lib/agent-actor'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import {
  getScheduledTask,
  markTaskExecuted,
  type ScheduledTask,
} from '@shared/lib/services/scheduled-task-service'
import { agentExists } from '@shared/lib/services/agent-service'
import { buildWakeMessage } from './wake-message'
import { randomUUID } from 'crypto'

export type WakeDeliveryResult =
  | { outcome: 'delivered'; sessionId: string }
  // Already delivered for this exact slot (lastWake matches); task status reconciled
  | { outcome: 'reconciled'; sessionId: string }
  // Another caller holds the claim right now — nothing sent, nothing changed
  | { outcome: 'in-flight' }
  // Fresh read shows the task is no longer deliverable (executed/cancelled/failed/missing)
  | { outcome: 'not-pending'; status: string }
  | { outcome: 'session-missing' }
  | { outcome: 'agent-missing' }

/**
 * Deliver a session wake. Throws on transient delivery failure (container
 * unreachable, send error) with the task left pending — callers decide the
 * retry policy. A wake the container certainly did not take, or whose session
 * it is not running, leaves the session idle; one it may be running keeps the
 * session busy until its stream settles it.
 */
export async function deliverSessionWake(
  staleTask: ScheduledTask,
  trigger: 'scheduled' | 'manual'
): Promise<WakeDeliveryResult> {
  const sessionId = staleTask.resumeSessionId
  if (!sessionId) {
    throw new Error(`Task ${staleTask.id} is not a session wake`)
  }

  // A task never changes agents, so the caller's copy names the one that
  // holds the claim. Cross-restart duplication is the lastWake guard's.
  const locks = agentRegistry.get(staleTask.agentSlug).locks
  const claimKey = `wake:${staleTask.id}`
  const claim = await locks.tryAcquire(claimKey)
  if (!claim) {
    return { outcome: 'in-flight' }
  }

  try {
    // Re-read under the claim: the caller's copy may predate the other path's
    // delivery (a due-task batch loaded just before a "Wake now", or vice versa).
    const task = await getScheduledTask(staleTask.id)
    if (!task || (task.status !== 'pending' && task.status !== 'paused')) {
      return { outcome: 'not-pending', status: task?.status ?? 'missing' }
    }
    const actor = agentRegistry.get(task.agentSlug)

    // Session-exists guard: the wake outlives most session lifecycles, so the
    // target may have been deleted while sleeping.
    const sessionMeta = await actor.sessions.metadata(sessionId)
    if (!sessionMeta) {
      return { outcome: 'session-missing' }
    }

    // Duplicate-fire guard (mirrors getSessionForScheduledExecution on the
    // create path): if this exact wake slot was already delivered, the send
    // succeeded but recording the execution didn't — just reconcile.
    const executionAt = task.nextExecutionAt.toISOString()
    if (
      sessionMeta.lastWake?.taskId === task.id &&
      sessionMeta.lastWake.executionAt === executionAt
    ) {
      await markTaskExecuted(task.id, sessionId)
      return { outcome: 'reconciled', sessionId }
    }

    if (!(await agentExists(task.agentSlug))) {
      return { outcome: 'agent-missing' }
    }

    // Cold start is fine: the delivery starts the container, and a session
    // with no live process resumes from the container's session descriptor.
    // If the session went to sleep with a blocking user-input request still
    // open (agent asked, nobody answered), it is cancelled so the wake
    // message starts a fresh turn instead of deadlocking behind the blocked tool.
    await actor.messages.deliver({
      sessionId,
      content: buildWakeMessage(task, trigger),
      uuid: randomUUID(),
      options: { shouldQuery: true },
      cancelAwaiting: true,
    })

    // Side effect landed; record the slot so a crash between here and
    // markTaskExecuted can't double-deliver on the next attempt.
    await actor.sessions.updateMetadata(sessionId, {
      lastWake: { taskId: task.id, executionAt },
    })
    await markTaskExecuted(task.id, sessionId)

    if (trigger === 'scheduled') {
      notificationManager
        .triggerScheduledSessionResumed(sessionId, task.agentSlug, task.id, sessionMeta.name)
        .catch((err) => {
          console.error('[WakeDelivery] Failed to trigger resume notification:', err)
        })
    }

    // The pending wake is session-level state (badges, resume banner) — nudge
    // session lists and the open session view to refetch.
    globalFeed.publish({
      type: 'session_updated',
      sessionId,
      agentSlug: task.agentSlug,
    })
    await actor.sessions.broadcastUpdate(sessionId)

    return { outcome: 'delivered', sessionId }
  } finally {
    await locks.release(claimKey, claim)
  }
}
