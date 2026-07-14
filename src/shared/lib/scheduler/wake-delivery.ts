/**
 * Session wake delivery — the single path that resumes a sleeping session,
 * shared by the scheduler's wake branch and the manual "Wake now" route.
 *
 * Both callers run in the same process (the scheduler singleton and the HTTP
 * routes live in one API server), so a per-task in-process claim makes
 * check-status → send → record a critical section: a scheduler poll and a
 * "Wake now" click landing simultaneously can never both deliver. The claim is
 * taken before delivery and the task status is re-read under it, while the
 * durable status flip (markTaskExecuted) stays AFTER the send — a crash
 * between send and record is caught by the lastWake metadata guard on the next
 * attempt, and a crash before the send loses nothing.
 */

import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { notificationManager } from '@shared/lib/notifications/notification-manager'
import {
  getScheduledTask,
  markTaskExecuted,
  type ScheduledTask,
} from '@shared/lib/services/scheduled-task-service'
import {
  getSessionMetadata,
  updateSessionMetadata,
} from '@shared/lib/services/session-service'
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

// Task ids currently being delivered. In-process is sufficient: all delivery
// callers share this process, and cross-restart duplication is covered by the
// lastWake metadata guard.
const inFlightWakes = new Set<string>()

/**
 * Deliver a session wake. Throws on transient delivery failure (container
 * unreachable, send error) with the task left pending — callers decide the
 * retry policy. The optimistic active flag is reverted before rethrowing so a
 * failed delivery never leaves the session looking busy.
 */
export async function deliverSessionWake(
  staleTask: ScheduledTask,
  trigger: 'scheduled' | 'manual'
): Promise<WakeDeliveryResult> {
  const sessionId = staleTask.resumeSessionId
  if (!sessionId) {
    throw new Error(`Task ${staleTask.id} is not a session wake`)
  }

  if (inFlightWakes.has(staleTask.id)) {
    return { outcome: 'in-flight' }
  }
  inFlightWakes.add(staleTask.id)

  try {
    // Re-read under the claim: the caller's copy may predate the other path's
    // delivery (a due-task batch loaded just before a "Wake now", or vice versa).
    const task = await getScheduledTask(staleTask.id)
    if (!task || (task.status !== 'pending' && task.status !== 'paused')) {
      return { outcome: 'not-pending', status: task?.status ?? 'missing' }
    }

    // Session-exists guard: the wake outlives most session lifecycles, so the
    // target may have been deleted while sleeping.
    const sessionMeta = await getSessionMetadata(task.agentSlug, sessionId)
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

    // Cold start is fine: sendMessage into a session with no live process
    // resumes it from the container's session descriptor.
    const client = await containerManager.ensureRunning(task.agentSlug)

    if (!messagePersister.isSubscribed(sessionId)) {
      await messagePersister.subscribeToSession(sessionId, client, sessionId, task.agentSlug)
    }

    // If the session went to sleep with a blocking user-input request still
    // open (agent asked, nobody answered), cancel it so the wake message
    // starts a fresh turn instead of deadlocking behind the blocked tool.
    await messagePersister.cancelAwaitingInput(sessionId, task.agentSlug)

    messagePersister.markSessionActive(sessionId, task.agentSlug)
    try {
      await client.sendMessage(sessionId, buildWakeMessage(task, trigger), randomUUID(), {
        shouldQuery: true,
      })
    } catch (error) {
      // The turn never started — clear the optimistic active flag so the UI
      // doesn't show a phantom "working" session while the wake awaits retry.
      messagePersister.markSessionIdle(sessionId)
      throw error
    }

    // Side effect landed; record the slot so a crash between here and
    // markTaskExecuted can't double-deliver on the next attempt.
    await updateSessionMetadata(task.agentSlug, sessionId, {
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
    messagePersister.broadcastGlobal({
      type: 'session_updated',
      sessionId,
      agentSlug: task.agentSlug,
    })
    messagePersister.broadcastSessionUpdate(sessionId)

    return { outcome: 'delivered', sessionId }
  } finally {
    inFlightWakes.delete(staleTask.id)
  }
}
