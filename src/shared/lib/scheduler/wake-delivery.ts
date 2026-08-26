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
  createSessionWake,
  getScheduledTask,
  markTaskExecuted,
  type ScheduledTask,
} from '@shared/lib/services/scheduled-task-service'
import { openTargets, parseWakeOnSessions } from '@shared/lib/services/wake-on-sessions'
import { isCallerIdle, trackInvokedSession } from './invoked-session-listener'
import {
  getSessionMetadata,
  updateSessionMetadata,
} from '@shared/lib/services/session-service'
import { agentExists } from '@shared/lib/services/agent-service'
import { buildWakeMessage, eventWakeWon } from './wake-message'
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
  // Event wake became due while A was idle; A started a turn or asked a
  // question before the poll. Leave the row pending for the next idle.
  | { outcome: 'caller-busy' }
  // Scheduled delivery found the row no longer due (reopened, or the time
  // moved into the future) after a slow step. Leave it pending.
  | { outcome: 'not-due' }

// Task ids currently being delivered. In-process is sufficient: all delivery
// callers share this process, and cross-restart duplication is covered by the
// lastWake metadata guard.
const inFlightWakes = new Set<string>()

function isDueNow(row: ScheduledTask): boolean {
  return row.nextExecutionAt != null && row.nextExecutionAt.getTime() <= Date.now()
}

/** Scheduled delivery only. Manual Wake now ignores due/idle and still sends. */
function scheduledHoldoff(
  trigger: 'scheduled' | 'manual',
  row: ScheduledTask,
  sessionId: string,
): WakeDeliveryResult | null {
  if (trigger !== 'scheduled') return null
  if (!isDueNow(row)) return { outcome: 'not-due' }
  const wake = parseWakeOnSessions(row.wakeOnSessions)
  if (eventWakeWon(row, wake) && !isCallerIdle(sessionId)) {
    return { outcome: 'caller-busy' }
  }
  return null
}

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
    // Due rows carry a time. A "Wake now" on an event row that is not yet due
    // has none; its creation instant is the stable slot for that row.
    const executionAt = (task.nextExecutionAt ?? task.createdAt).toISOString()
    if (
      sessionMeta.lastWake?.taskId === task.id &&
      sessionMeta.lastWake.executionAt === executionAt
    ) {
      await finalizeExecutedRow(task, sessionId)
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

    // Read the row once more: the listener may have stamped a target since the
    // claim re-read, and the message must describe the row that gets executed.
    const latest = (await getScheduledTask(task.id)) ?? task
    const holdoffBeforeBuild = scheduledHoldoff(trigger, latest, sessionId)
    if (holdoffBeforeBuild) return holdoffBeforeBuild

    // Build first: reading the finished agents' transcripts can fail, and a
    // failure must leave the caller exactly as it was — no cancelled question,
    // no phantom "working" state.
    const message = await buildWakeMessage(latest, trigger)

    // Re-read after the slow build. addWakeTarget can reopen and un-due the
    // row, or A can start a turn / park on a question, while we waited.
    const current = (await getScheduledTask(task.id)) ?? latest
    const holdoffAfterBuild = scheduledHoldoff(trigger, current, sessionId)
    if (holdoffAfterBuild) return holdoffAfterBuild
    const currentWake = parseWakeOnSessions(current.wakeOnSessions)

    // Event winners wait for a turn boundary, so they must not cancel a
    // question we just reconfirmed is absent. Timed and manual still cancel.
    if (trigger === 'manual' || !eventWakeWon(current, currentWake)) {
      await messagePersister.cancelAwaitingInput(sessionId, current.agentSlug)
    }

    messagePersister.markSessionActive(sessionId, current.agentSlug)
    try {
      await client.sendMessage(sessionId, message, randomUUID(), {
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
    const deliveredAt = (current.nextExecutionAt ?? current.createdAt).toISOString()
    await updateSessionMetadata(current.agentSlug, sessionId, {
      lastWake: { taskId: current.id, executionAt: deliveredAt },
    })
    await finalizeExecutedRow(current, sessionId)

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

/**
 * Mark the row executed and re-create whatever it still carried. A stamped
 * target must not come back as open, so callers pass the freshest row they
 * hold. The wake already landed, so a remainder failure is logged, not thrown.
 */
async function finalizeExecutedRow(row: ScheduledTask, sessionId: string): Promise<void> {
  await markTaskExecuted(row.id, sessionId)
  await recreateRemainder(row).catch((error) => {
    console.error('[WakeDelivery] Failed to re-create wake remainder:', error)
  })
}

async function recreateRemainder(task: ScheduledTask): Promise<void> {
  const sessionId = task.resumeSessionId
  const wake = parseWakeOnSessions(task.wakeOnSessions)
  if (!wake || !sessionId) return
  const createdByUserId = task.createdByUserId ?? undefined
  const open = openTargets(wake)
  if (open.length > 0) {
    // Same path as a fresh invoke: a target that finished during delivery is
    // settled straight away instead of waiting for an event that already fired.
    for (const target of open) {
      await trackInvokedSession({ callerAgentSlug: task.agentSlug, callerSessionId: sessionId, createdByUserId, target })
    }
    return
  }
  if (wake.deferredTimerAt) {
    const wakeAt = new Date(wake.deferredTimerAt)
    if (wakeAt.getTime() <= Date.now()) return
    await createSessionWake({
      agentSlug: task.agentSlug,
      scheduleExpression: task.scheduleExpression,
      note: task.prompt,
      sessionId,
      createdByUserId,
      timezone: task.timezone ?? undefined,
      wakeAt,
    })
  }
}
