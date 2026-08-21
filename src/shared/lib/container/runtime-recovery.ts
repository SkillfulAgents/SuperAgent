import { randomUUID } from 'crypto'
import { addErrorBreadcrumb, captureException } from '@shared/lib/error-reporting'
import type { ContainerClient } from './types'
import { buildRecoveryPrompt, type RuntimeFatalKind, type UnexpectedDeathPlan } from './runtime-death'

// Session lifecycle here: active --(unexpected death)--> isRecovering --> either
// markRecovered (resume prompt sent, turn continues) or settleRecoveringSessions
// (today's session_error). Flags live in message-persister; this module only orchestrates.

export type RuntimeRecoveryDeps = {
  agentId: string
  isStopping: () => boolean
  getClient: () => ContainerClient
  restartAgent: () => Promise<void>
  ensureRunning: () => Promise<ContainerClient>
  snapshotMidTurnSessions: (agentId: string) => string[]
  consumeLastFatal: (agentId: string) => RuntimeFatalKind
  settleRecoveringSessions: (sessionIds: string[]) => void
  markRecovered: (sessionIds: string[]) => void
  takeCoalescedUserMessage: (sessionId: string) => string | undefined
  isSessionRecovering: (sessionId: string) => boolean
  isSubscribed: (sessionId: string) => boolean
  subscribeToSession: (
    sessionId: string,
    client: ContainerClient,
    containerSessionId: string,
    agentSlug: string,
  ) => Promise<void>
  onIdleDeath?: () => Promise<void>
}

const OBSERVE_TIMEOUT_MS = 30_000
const RESTART_TIMEOUT_MS = 5 * 60_000
// Crash-loop brake: a runtime that dies after every resume would otherwise
// restart + burn a model turn forever. Over budget -> settle as session_error.
const RECOVERY_WINDOW_MS = 30 * 60_000
const MAX_RECOVERIES_PER_WINDOW = 3

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
    pendingRerun.set(deps.agentId, deps)
    return existing
  }
  const run = recoverFromUnexpectedDeathInner(deps).finally(() => {
    inFlight.delete(deps.agentId)
    const rerunDeps = pendingRerun.get(deps.agentId)
    if (rerunDeps) {
      pendingRerun.delete(deps.agentId)
      void recoverFromUnexpectedDeath(rerunDeps)
    }
  })
  inFlight.set(deps.agentId, run)
  return run
}

async function recoverFromUnexpectedDeathInner(deps: RuntimeRecoveryDeps): Promise<void> {
  if (deps.isStopping()) return

  const sessionIds = deps.snapshotMidTurnSessions(deps.agentId)
  if (sessionIds.length === 0) {
    await deps.onIdleDeath?.()
    return
  }

  const client = deps.getClient()
  const lastFatalResult = deps.consumeLastFatal(deps.agentId)
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
    deps.settleRecoveringSessions(sessionIds)
    return
  }

  if (deps.isStopping()) {
    deps.settleRecoveringSessions(sessionIds)
    return
  }

  if (plan.action === 'ignore') {
    // Take coalesced messages before markRecovered clears them; the turn is
    // still running on the container, so deliver them as normal queued sends.
    const coalesced = new Map<string, string>()
    for (const sessionId of sessionIds) {
      const text = deps.takeCoalescedUserMessage(sessionId)
      if (text) coalesced.set(sessionId, text)
    }
    deps.markRecovered(sessionIds)
    await resubscribeSessions(deps, client, sessionIds)
    for (const [sessionId, text] of coalesced) {
      try {
        await client.sendMessage(sessionId, text, randomUUID(), { shouldQuery: true })
      } catch (error) {
        captureException(error, {
          tags: { area: 'container', op: 'runtime.recovery.deliverCoalesced' },
          extra: { agentId: deps.agentId, sessionId },
        })
      }
    }
    return
  }

  if (plan.action === 'settle') {
    deps.settleRecoveringSessions(sessionIds)
    return
  }

  if (!underRecoveryBudget(deps.agentId)) {
    captureException(new Error('Runtime recovery budget exhausted, settling as session_error'), {
      tags: { area: 'container', op: 'runtime.recover.budget' },
      extra: { agentId: deps.agentId, reason: plan.reason, sessionIds },
    })
    deps.settleRecoveringSessions(sessionIds)
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
    deps.settleRecoveringSessions(sessionIds.filter((id) => deps.isSessionRecovering(id)))
  }
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
      await deps.subscribeToSession(sessionId, client, sessionId, deps.agentId)
    } catch (error) {
      captureException(error, {
        tags: { area: 'container', op: 'runtime.resubscribe' },
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
        await deps.subscribeToSession(sessionId, client, sessionId, deps.agentId)
      }
      const prompt = buildRecoveryPrompt(plan.resumePrompt, deps.takeCoalescedUserMessage(sessionId))
      await client.sendMessage(sessionId, prompt, randomUUID(), { shouldQuery: true })
      deps.markRecovered([sessionId])
    } catch (error) {
      captureException(error, {
        tags: { area: 'container', op: 'runtime.resume' },
        extra: { agentId: deps.agentId, sessionId, reason: plan.reason },
      })
      failed.push(sessionId)
    }
  }
  if (failed.length > 0) deps.settleRecoveringSessions(failed)
}
