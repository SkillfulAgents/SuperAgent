import { randomUUID } from 'crypto'
import { addErrorBreadcrumb, captureException } from '@shared/lib/error-reporting'
import type { ContainerClient } from './types'
import type { CoalescedUserMessage, RuntimeFatalKind, UnexpectedDeathPlan } from './runtime-death'

// Session lifecycle here: active --(unexpected death)--> isRecovering --> either
// markRecovered (resume prompt sent, turn continues) or settleRecoveringSessions
// (today's session_error). Flags live in message-persister; this module only orchestrates.

export type RuntimeRecoveryDeps = {
  agentId: string
  isStopping: () => boolean
  getClient: () => ContainerClient
  restartAgent: () => Promise<void>
  ensureRunning: () => Promise<ContainerClient>
  snapshotMidTurnSessions: (agentId: string, restrictToSessionIds?: string[]) => string[]
  consumeLastFatal: (agentId: string) => RuntimeFatalKind
  settleRecoveringSessions: (sessionIds: string[]) => void
  markRecovered: (sessionIds: string[]) => void
  takeCoalescedUserMessages: (sessionId: string) => CoalescedUserMessage[]
  isSessionRecovering: (sessionId: string) => boolean
  isSubscribed: (sessionId: string) => boolean
  subscribeToSession: (
    sessionId: string,
    client: ContainerClient,
    containerSessionId: string,
  ) => Promise<void>
  syncAgentStatus?: () => Promise<void>
  // One-session connection_closed. Omitted = every mid-turn session on the agent.
  restrictToSessionIds?: string[]
}

const OBSERVE_TIMEOUT_MS = 30_000
const RESTART_TIMEOUT_MS = 5 * 60_000
// Crash-loop brake only. Mid-turn deaths resume; this is the emergency stop
// so a runtime that dies after every resume cannot burn model turns forever.
const RECOVERY_WINDOW_MS = 30 * 60_000
const MAX_RECOVERIES_PER_WINDOW = 5

const inFlight = new Map<string, Promise<void>>()
// Death signal arrived while a recovery was in flight; re-run once after it
// finishes so sessions the first snapshot missed are not stranded isRecovering.
const pendingRerun = new Map<string, RuntimeRecoveryDeps>()
const recoveryHistory = new Map<string, number[]>()

export function resetRuntimeRecoveryForTests(): void {
  inFlight.clear()
  pendingRerun.clear()
  recoveryHistory.clear()
}

export async function recoverFromUnexpectedDeath(deps: RuntimeRecoveryDeps): Promise<void> {
  const existing = inFlight.get(deps.agentId)
  if (existing) {
    pendingRerun.set(deps.agentId, widenRecoveryScope(pendingRerun.get(deps.agentId), deps))
    return existing
  }
  const run = recoverFromUnexpectedDeathInner(deps).finally(() => {
    inFlight.delete(deps.agentId)
    const rerunDeps = pendingRerun.get(deps.agentId)
    if (rerunDeps) {
      pendingRerun.delete(deps.agentId)
      recoverFromUnexpectedDeath(rerunDeps).catch((error) => {
        captureException(error, {
          tags: { area: 'container', op: 'runtime.recover.rerun' },
          extra: { agentId: rerunDeps.agentId },
        })
      })
    }
  })
  inFlight.set(deps.agentId, run)
  return run
}

function widenRecoveryScope(
  prev: RuntimeRecoveryDeps | undefined,
  next: RuntimeRecoveryDeps,
): RuntimeRecoveryDeps {
  if (!prev) return next
  const prevScope = prev.restrictToSessionIds
  const nextScope = next.restrictToSessionIds
  if (!prevScope || !nextScope) {
    return { ...next, restrictToSessionIds: undefined }
  }
  return {
    ...next,
    restrictToSessionIds: [...new Set([...prevScope, ...nextScope])],
  }
}

async function recoverFromUnexpectedDeathInner(deps: RuntimeRecoveryDeps): Promise<void> {
  // Consume unconditionally: a fatal left behind by an early return below must
  // not leak into a later, unrelated recovery and skew its classification.
  const lastFatalResult = deps.consumeLastFatal(deps.agentId)
  const sessionIds = deps.snapshotMidTurnSessions(deps.agentId, deps.restrictToSessionIds)
  if (deps.isStopping()) {
    await settleAndSync(deps, sessionIds)
    return
  }
  if (sessionIds.length === 0) {
    await deps.syncAgentStatus?.()
    return
  }

  const client = deps.getClient()
  const oldGenerationId = client.getRuntimeGenerationId()

  let plan: UnexpectedDeathPlan
  try {
    plan = await withTimeout(
      client.observeUnexpectedDeath({ lastFatalResult, sessionIds }),
      OBSERVE_TIMEOUT_MS,
      'observeUnexpectedDeath',
    )
  } catch (error) {
    captureException(error, {
      tags: { area: 'container', op: 'runtime.observeDeath' },
      extra: { agentId: deps.agentId, sessionIds },
    })
    await settleAndSync(deps, sessionIds)
    return
  }

  if (deps.isStopping()) {
    await settleAndSync(deps, sessionIds)
    return
  }

  if (plan.action === 'ignore') {
    try {
      await ignoreDeath(deps, client, sessionIds, plan.liveSessionIds)
    } catch (error) {
      captureException(error, {
        tags: { area: 'container', op: 'runtime.recover.ignore' },
        extra: { agentId: deps.agentId, sessionIds },
      })
      await settleAndSync(
        deps,
        sessionIds.filter((id) => deps.isSessionRecovering(id)),
      )
    }
    return
  }

  if (plan.action === 'settle') {
    await settleAndSync(deps, sessionIds)
    return
  }

  if (!underRecoveryBudget(deps.agentId)) {
    captureException(new Error('Runtime recovery budget exhausted, settling as session_error'), {
      tags: { area: 'container', op: 'runtime.recover.budget' },
      extra: { agentId: deps.agentId, reason: plan.reason, sessionIds },
    })
    await settleAndSync(deps, sessionIds)
    return
  }

  try {
    const resumeClient = await withTimeout(
      prepareResumeClient(deps, plan.replaceGeneration),
      RESTART_TIMEOUT_MS,
      'runtime restart',
    )
    addErrorBreadcrumb({
      category: 'container',
      message: 'Runtime mid-turn recovery',
      data: {
        agentId: deps.agentId,
        reason: plan.reason,
        replaceGeneration: plan.replaceGeneration,
        sessionIds,
        oldGenerationId,
        newGenerationId: resumeClient.getRuntimeGenerationId(),
      },
      level: 'warning',
    })
    await resumeSessions(deps, resumeClient, sessionIds, plan)
  } catch (error) {
    captureException(error, {
      tags: { area: 'container', op: 'runtime.recover' },
      extra: { agentId: deps.agentId, reason: plan.reason, sessionIds },
    })
    await settleAndSync(
      deps,
      sessionIds.filter((id) => deps.isSessionRecovering(id)),
    )
  }
}

async function ignoreDeath(
  deps: RuntimeRecoveryDeps,
  client: ContainerClient,
  sessionIds: string[],
  liveSessionIds: string[] | undefined,
): Promise<void> {
  const live = new Set(liveSessionIds ?? sessionIds)
  const dead = sessionIds.filter((id) => !live.has(id))
  const keep = sessionIds.filter((id) => live.has(id))
  if (dead.length > 0) await settleAndSync(deps, dead)

  // Take coalesced messages before markRecovered clears them; the turn is
  // still running on the container, so deliver them as normal queued sends.
  const coalesced = new Map<string, CoalescedUserMessage[]>()
  for (const sessionId of keep) {
    const messages = deps.takeCoalescedUserMessages(sessionId)
    if (messages.length > 0) coalesced.set(sessionId, messages)
  }
  deps.markRecovered(keep)
  await resubscribeSessions(deps, client, keep)
  for (const [sessionId, messages] of coalesced) {
    await deliverCoalescedMessages(deps, client, sessionId, messages)
  }
}

async function settleAndSync(deps: RuntimeRecoveryDeps, sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return
  deps.settleRecoveringSessions(sessionIds)
  await deps.syncAgentStatus?.()
}

function underRecoveryBudget(agentId: string): boolean {
  const now = Date.now()
  const recent = (recoveryHistory.get(agentId) ?? []).filter((t) => now - t < RECOVERY_WINDOW_MS)
  recent.push(now)
  recoveryHistory.set(agentId, recent)
  return recent.length <= MAX_RECOVERIES_PER_WINDOW
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function prepareResumeClient(
  deps: RuntimeRecoveryDeps,
  replaceGeneration: boolean,
): Promise<ContainerClient> {
  if (replaceGeneration) {
    await deps.restartAgent()
    return deps.ensureRunning()
  }
  return deps.getClient()
}

async function resubscribeSessions(
  deps: RuntimeRecoveryDeps,
  client: ContainerClient,
  sessionIds: string[],
): Promise<void> {
  for (const sessionId of sessionIds) {
    if (deps.isStopping() || deps.isSubscribed(sessionId)) continue
    try {
      await deps.subscribeToSession(sessionId, client, sessionId)
    } catch (error) {
      captureException(error, {
        tags: { area: 'container', op: 'runtime.resubscribe' },
        extra: { agentId: deps.agentId, sessionId },
      })
    }
  }
}

async function deliverCoalescedMessages(
  deps: RuntimeRecoveryDeps,
  client: ContainerClient,
  sessionId: string,
  messages: CoalescedUserMessage[],
): Promise<void> {
  for (const message of messages) {
    try {
      await client.sendMessage(sessionId, message.text, message.uuid, { shouldQuery: true })
    } catch (error) {
      captureException(error, {
        tags: { area: 'container', op: 'runtime.recovery.deliverCoalesced' },
        extra: { agentId: deps.agentId, sessionId },
      })
    }
  }
}

async function resumeSessions(
  deps: RuntimeRecoveryDeps,
  client: ContainerClient,
  sessionIds: string[],
  plan: Extract<UnexpectedDeathPlan, { action: 'recover' }>,
): Promise<void> {
  const failed: string[] = []
  for (const sessionId of sessionIds) {
    if (deps.isStopping()) {
      if (deps.isSessionRecovering(sessionId)) failed.push(sessionId)
      continue
    }
    // No longer recovering: the user interrupted or it settled during recovery.
    if (!deps.isSessionRecovering(sessionId)) continue
    try {
      if (!deps.isSubscribed(sessionId)) {
        await deps.subscribeToSession(sessionId, client, sessionId)
      }
      await client.sendMessage(sessionId, plan.resumePrompt, randomUUID(), { shouldQuery: true })
      const coalesced = deps.takeCoalescedUserMessages(sessionId)
      deps.markRecovered([sessionId])
      await deliverCoalescedMessages(deps, client, sessionId, coalesced)
    } catch (error) {
      captureException(error, {
        tags: { area: 'container', op: 'runtime.resume' },
        extra: { agentId: deps.agentId, sessionId, reason: plan.reason },
      })
      failed.push(sessionId)
    }
  }
  if (failed.length > 0) await settleAndSync(deps, failed)
}
