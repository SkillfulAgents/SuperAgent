/**
 * Invoked-session listener — the event half of sleep-on-invoke.
 *
 * When agent A invokes agent B and ends its turn, A's pending session wake
 * (the same scheduled_tasks row schedule_resume uses) lists B as a target.
 * This listener watches the persister's global stream for B's turn ending,
 * stamps the outcome on that list, and makes the row due once every target is
 * stamped and A is idle. Delivery is the scheduler's: it polls due rows and
 * calls deliverSessionWake, which brings its retry window and boot pickup.
 */

import { containerManager } from '@shared/lib/container/container-manager'
import { messagePersister } from '@shared/lib/container/message-persister'
import { captureException } from '@shared/lib/error-reporting'
import {
  addWakeTarget,
  listPendingEventWakes,
  markWakeDueIfSettled,
  settleWakeTarget,
} from '@shared/lib/services/scheduled-task-service'
import { openTargets, parseWakeOnSessions, type WakeTarget } from '@shared/lib/services/wake-on-sessions'

let kickDueWakes: (() => void) | null = null

/** Wire the existing scheduler scan so a due event wake does not wait for the poll. */
export function setKickDueWakes(fn: (() => void) | null): void {
  kickDueWakes = fn
}

export function kickIfWakeBecameDue(becameDue: boolean | readonly string[]): void {
  const due = Array.isArray(becameDue) ? becameDue.length > 0 : becameDue
  if (due) kickDueWakes?.()
}

function kickIfBecameDue(becameDue: boolean | readonly string[]): void {
  kickIfWakeBecameDue(becameDue)
}

/** A caller may be woken only at a turn boundary, never over an open question. */
export function isCallerIdle(sessionId: string): boolean {
  return !messagePersister.isSessionActive(sessionId) && !messagePersister.isSessionAwaitingInput(sessionId)
}

// Terminal events seen recently, so a target that finished before its row
// existed is settled with what actually happened, not assumed completed.
const RECENT_OUTCOME_TTL_MS = 5 * 60 * 1000
const recentOutcomes = new Map<string, { outcome: 'completed' | 'errored'; at: number }>()

function rememberOutcome(sessionId: string, outcome: 'completed' | 'errored'): void {
  const now = Date.now()
  recentOutcomes.set(sessionId, { outcome, at: now })
  for (const [id, seen] of recentOutcomes) {
    if (now - seen.at > RECENT_OUTCOME_TTL_MS) recentOutcomes.delete(id)
  }
}

function recentOutcome(sessionId: string): 'completed' | 'errored' {
  const seen = recentOutcomes.get(sessionId)
  return seen && Date.now() - seen.at <= RECENT_OUTCOME_TTL_MS ? seen.outcome : 'completed'
}

/**
 * Record that the caller session is waiting on an invoked session. If the
 * target already finished (a fast turn that ended before the row was
 * written), settle it now so the wake is not lost.
 */
export async function trackInvokedSession(params: {
  callerAgentSlug: string
  callerSessionId: string
  createdByUserId?: string
  target: WakeTarget
}): Promise<void> {
  await addWakeTarget({
    agentSlug: params.callerAgentSlug,
    sessionId: params.callerSessionId,
    target: params.target,
    createdByUserId: params.createdByUserId,
  })
  // Same pair schedule_resume / deliverSessionWake use so the open
  // session refetches pendingWake* and the banner can mount after idle.
  messagePersister.broadcastGlobal({
    type: 'session_updated',
    sessionId: params.callerSessionId,
    agentSlug: params.callerAgentSlug,
  })
  messagePersister.broadcastSessionUpdate(params.callerSessionId)
  if (!messagePersister.isSessionActive(params.target.sessionId)) {
    const due = await settleWakeTarget({
      targetSessionId: params.target.sessionId,
      outcome: recentOutcome(params.target.sessionId),
      callerIdle: isCallerIdle,
    })
    kickIfBecameDue(due)
  }
}

interface TerminalSessionEvent {
  type: 'session_idle' | 'session_error'
  sessionId: string
}

function isTerminalSessionEvent(event: unknown): event is TerminalSessionEvent {
  if (typeof event !== 'object' || event === null) return false
  const type = Reflect.get(event, 'type')
  const sessionId = Reflect.get(event, 'sessionId')
  return (type === 'session_idle' || type === 'session_error') && typeof sessionId === 'string'
}

class InvokedSessionListener {
  private unsubscribe: (() => void) | null = null

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = messagePersister.addGlobalNotificationClient((event: unknown) => {
      this.handle(event).catch((error) => {
        console.error('[InvokedSessionListener] Error handling session event:', error)
        captureException(error, { tags: { component: 'invoked-session-listener', phase: 'event' } })
      })
    })
    console.log('[InvokedSessionListener] Started')
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async handle(event: unknown): Promise<void> {
    if (!isTerminalSessionEvent(event)) return
    const outcome = event.type === 'session_error' ? 'errored' : 'completed'
    rememberOutcome(event.sessionId, outcome)
    // As a target: stamp the outcome on every wake waiting on this session.
    const settledDue = await settleWakeTarget({ targetSessionId: event.sessionId, outcome, callerIdle: isCallerIdle })
    // As a caller: a fully-settled wake that waited for this session's turn
    // boundary becomes due now. Already-due (caller-busy holdoff) also kicks.
    const markedDue = await markWakeDueIfSettled(event.sessionId)
    kickIfBecameDue(settledDue.length > 0 || markedDue)
  }

  /**
   * After a host restart nothing is subscribed, so a target that finished
   * while the host was down never emits idle. Probe each open target once:
   * container down → unknown (unless runtime recovery is resuming it);
   * container up and session running → mark active and subscribe so its
   * terminal event is honored; container up and session idle → unknown.
   * A row that becomes due here kicks the existing scan so it does not wait
   * for the next poll tick.
   */
  async reconcileAtBoot(): Promise<void> {
    const rows = await listPendingEventWakes()
    let becameDue = false
    for (const row of rows) {
      const wake = parseWakeOnSessions(row.wakeOnSessions)
      if (!wake || !row.resumeSessionId) continue
      for (const target of openTargets(wake)) {
        try {
          await this.reconcileTarget(target)
        } catch (error) {
          console.error('[InvokedSessionListener] Boot reconcile failed for target:', target.sessionId, error)
          captureException(error, {
            tags: { component: 'invoked-session-listener', phase: 'boot' },
            extra: { targetSessionId: target.sessionId, agentSlug: target.agentSlug },
          })
        }
      }
      if (await markWakeDueIfSettled(row.resumeSessionId)) becameDue = true
    }
    kickIfBecameDue(becameDue)
  }

  private async reconcileTarget(target: WakeTarget): Promise<void> {
    const info = await containerManager.syncAgentStatus(target.agentSlug)
    if (info.status !== 'running') {
      if (messagePersister.isSessionRecovering(target.sessionId)) return
      await settleWakeTarget({ targetSessionId: target.sessionId, outcome: 'unknown', callerIdle: isCallerIdle })
      return
    }
    const client = containerManager.getClient(target.agentSlug)
    const session = await client.getSession(target.sessionId)
    if (session?.isRunning) {
      // Same order the invoke route uses: active first, so the idle that
      // follows is honored instead of ignored as a stale event.
      messagePersister.markSessionActive(target.sessionId, target.agentSlug)
      if (!messagePersister.isSubscribed(target.sessionId)) {
        await messagePersister.subscribeToSession(target.sessionId, client, target.sessionId, target.agentSlug)
      }
      return
    }
    await settleWakeTarget({ targetSessionId: target.sessionId, outcome: 'unknown', callerIdle: isCallerIdle })
  }
}

export const invokedSessionListener = new InvokedSessionListener()
