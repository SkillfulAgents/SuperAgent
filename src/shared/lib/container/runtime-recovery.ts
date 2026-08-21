import { randomUUID } from 'crypto'
import { addErrorBreadcrumb, captureException } from '@shared/lib/error-reporting'
import type { ContainerClient } from './types'
import {
  buildRecoveryPrompt,
  type RecoverableDeathReason,
  type RuntimeFatalKind,
} from './runtime-death'

export type RuntimeRecoveryDeps = {
  agentId: string
  isStopping: () => boolean
  getClient: () => ContainerClient
  restartAgent: () => Promise<void>
  ensureRunning: () => Promise<ContainerClient>
  snapshotMidTurnSessions: (agentId: string) => string[]
  consumeLastFatal: (agentId: string) => RuntimeFatalKind
  settleRecoveringSessions: (sessionIds: string[]) => void
  releaseRecovery: (sessionIds: string[]) => void
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

const inFlight = new Map<string, Promise<void>>()

export function resetRuntimeRecoveryForTests(): void {
  inFlight.clear()
}

export async function recoverFromUnexpectedDeath(deps: RuntimeRecoveryDeps): Promise<void> {
  const existing = inFlight.get(deps.agentId)
  if (existing) return existing
  const run = recoverFromUnexpectedDeathInner(deps).finally(() => {
    inFlight.delete(deps.agentId)
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
  const plan = await client.observeUnexpectedDeath({ lastFatalResult, sessionIds })

  if (deps.isStopping()) {
    deps.settleRecoveringSessions(sessionIds)
    return
  }

  if (plan.action === 'ignore') {
    deps.releaseRecovery(sessionIds)
    await resubscribeSessions(deps, client, sessionIds)
    return
  }

  if (plan.action === 'settle') {
    deps.settleRecoveringSessions(sessionIds)
    return
  }

  try {
    const resumeClient = await prepareResumeClient(deps, plan.replaceGeneration)
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
    await resumeSessions(deps, resumeClient, sessionIds, plan.reason)
  } catch (error) {
    captureException(error, {
      tags: { area: 'container', op: 'runtime.recover' },
      extra: { agentId: deps.agentId, reason: plan.reason, sessionIds },
    })
    deps.settleRecoveringSessions(sessionIds.filter((id) => deps.isSessionRecovering(id)))
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
  reason: RecoverableDeathReason,
): Promise<void> {
  const failed: string[] = []
  for (const sessionId of sessionIds) {
    if (deps.isStopping() || !deps.isSessionRecovering(sessionId)) {
      if (deps.isSessionRecovering(sessionId)) failed.push(sessionId)
      continue
    }
    try {
      if (!deps.isSubscribed(sessionId)) {
        await deps.subscribeToSession(sessionId, client, sessionId, deps.agentId)
      }
      const prompt = buildRecoveryPrompt(reason, deps.takeCoalescedUserMessage(sessionId))
      await client.sendMessage(sessionId, prompt, randomUUID(), { shouldQuery: true })
      deps.releaseRecovery([sessionId])
    } catch (error) {
      captureException(error, {
        tags: { area: 'container', op: 'runtime.resume' },
        extra: { agentId: deps.agentId, sessionId, reason },
      })
      failed.push(sessionId)
    }
  }
  if (failed.length > 0) deps.settleRecoveringSessions(failed)
}
