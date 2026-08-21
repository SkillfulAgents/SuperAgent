import { describe, expect, it, vi, beforeEach } from 'vitest'
import { addErrorBreadcrumb } from '@shared/lib/error-reporting'
import { RECOVERY_PROMPTS } from './runtime-death'
import {
  recoverFromUnexpectedDeath,
  resetRuntimeRecoveryForTests,
  type RuntimeRecoveryDeps,
} from './runtime-recovery'
import type { ContainerClient } from './types'
import type { UnexpectedDeathPlan } from './runtime-death'

vi.mock('@shared/lib/error-reporting', () => ({
  addErrorBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}))

function createDeps(overrides: Partial<RuntimeRecoveryDeps> = {}): RuntimeRecoveryDeps & {
  restartAgent: ReturnType<typeof vi.fn>
  ensureRunning: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  observeUnexpectedDeath: ReturnType<typeof vi.fn>
  settleRecoveringSessions: ReturnType<typeof vi.fn>
  releaseRecovery: ReturnType<typeof vi.fn>
  subscribeToSession: ReturnType<typeof vi.fn>
  onIdleDeath: ReturnType<typeof vi.fn>
} {
  const sendMessage = vi.fn().mockResolvedValue(undefined)
  const observeUnexpectedDeath = vi.fn<(input?: unknown) => Promise<UnexpectedDeathPlan>>()
  observeUnexpectedDeath.mockResolvedValue({ action: 'settle' })
  const restartAgent = vi.fn().mockResolvedValue(undefined)
  const ensureRunning = vi.fn()
  const settleRecoveringSessions = vi.fn()
  const releaseRecovery = vi.fn()
  const subscribeToSession = vi.fn().mockResolvedValue(undefined)
  const onIdleDeath = vi.fn().mockResolvedValue(undefined)
  let recovering = new Set<string>()

  const client = {
    sendMessage,
    observeUnexpectedDeath,
    getRuntimeGenerationId: () => 'mvm-old',
  } as unknown as ContainerClient

  ensureRunning.mockResolvedValue({
    ...client,
    getRuntimeGenerationId: () => 'mvm-new',
  })

  const deps: RuntimeRecoveryDeps = {
    agentId: 'agent-1',
    isStopping: () => false,
    getClient: () => client,
    restartAgent,
    ensureRunning,
    snapshotMidTurnSessions: () => {
      recovering = new Set(['sess-1'])
      return ['sess-1']
    },
    consumeLastFatal: () => null,
    settleRecoveringSessions: (ids) => {
      settleRecoveringSessions(ids)
      for (const id of ids) recovering.delete(id)
    },
    releaseRecovery: (ids) => {
      releaseRecovery(ids)
      for (const id of ids) recovering.delete(id)
    },
    takeCoalescedUserMessage: () => undefined,
    isSessionRecovering: (id) => recovering.has(id),
    isSubscribed: () => false,
    subscribeToSession,
    onIdleDeath,
    ...overrides,
  }

  return {
    ...deps,
    restartAgent,
    ensureRunning,
    sendMessage,
    observeUnexpectedDeath,
    settleRecoveringSessions,
    releaseRecovery,
    subscribeToSession,
    onIdleDeath,
  }
}

describe('recoverFromUnexpectedDeath', () => {
  beforeEach(() => {
    resetRuntimeRecoveryForTests()
    vi.clearAllMocks()
  })

  it('restarts once and resumes mid-turn sessions with the 8h prompt', async () => {
    const deps = createDeps()
    deps.observeUnexpectedDeath.mockResolvedValue({
      action: 'recover',
      reason: 'max_lifetime',
      replaceGeneration: true,
    })

    await recoverFromUnexpectedDeath(deps)

    expect(deps.restartAgent).toHaveBeenCalledTimes(1)
    expect(deps.ensureRunning).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage.mock.calls[0][0]).toBe('sess-1')
    expect(deps.sendMessage.mock.calls[0][1]).toBe(RECOVERY_PROMPTS.max_lifetime)
    expect(deps.sendMessage.mock.calls[0][3]).toEqual({ shouldQuery: true })
    expect(deps.releaseRecovery).toHaveBeenCalledWith(['sess-1'])
    expect(deps.settleRecoveringSessions).not.toHaveBeenCalled()
    expect(addErrorBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentId: 'agent-1',
          reason: 'max_lifetime',
          replaceGeneration: true,
          sessionIds: ['sess-1'],
          oldGenerationId: 'mvm-old',
          newGenerationId: 'mvm-new',
        }),
      }),
    )
  })

  it('does not replace the generation on guest_oom and resumes with the OOM prompt', async () => {
    const deps = createDeps({
      consumeLastFatal: () => 'oom_sigkill',
    })
    deps.observeUnexpectedDeath.mockResolvedValue({
      action: 'recover',
      reason: 'guest_oom',
      replaceGeneration: false,
    })

    await recoverFromUnexpectedDeath(deps)

    expect(deps.restartAgent).not.toHaveBeenCalled()
    expect(deps.ensureRunning).not.toHaveBeenCalled()
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'sess-1',
      RECOVERY_PROMPTS.guest_oom,
      expect.any(String),
      { shouldQuery: true },
    )
    expect(deps.observeUnexpectedDeath).toHaveBeenCalledWith({
      lastFatalResult: 'oom_sigkill',
      sessionIds: ['sess-1'],
    })
  })

  it('does not inject a resume message when the death is a live-session blip', async () => {
    const deps = createDeps()
    deps.observeUnexpectedDeath.mockResolvedValue({ action: 'ignore' })

    await recoverFromUnexpectedDeath(deps)

    expect(deps.restartAgent).not.toHaveBeenCalled()
    expect(deps.sendMessage).not.toHaveBeenCalled()
    expect(deps.releaseRecovery).toHaveBeenCalledWith(['sess-1'])
    expect(deps.settleRecoveringSessions).not.toHaveBeenCalled()
    expect(deps.subscribeToSession).toHaveBeenCalled()
  })

  it('does not resume when the agent is stopping', async () => {
    const deps = createDeps({ isStopping: () => true })
    deps.observeUnexpectedDeath.mockResolvedValue({
      action: 'recover',
      reason: 'runtime_lost',
      replaceGeneration: true,
    })

    await recoverFromUnexpectedDeath(deps)

    expect(deps.restartAgent).not.toHaveBeenCalled()
    expect(deps.sendMessage).not.toHaveBeenCalled()
    expect(deps.settleRecoveringSessions).not.toHaveBeenCalled()
  })

  it('does not resume idle sessions', async () => {
    const deps = createDeps({
      snapshotMidTurnSessions: () => [],
    })
    deps.observeUnexpectedDeath.mockResolvedValue({
      action: 'recover',
      reason: 'max_lifetime',
      replaceGeneration: true,
    })

    await recoverFromUnexpectedDeath(deps)

    expect(deps.onIdleDeath).toHaveBeenCalledTimes(1)
    expect(deps.restartAgent).not.toHaveBeenCalled()
    expect(deps.sendMessage).not.toHaveBeenCalled()
    expect(deps.observeUnexpectedDeath).not.toHaveBeenCalled()
  })

  it('single-flights concurrent deaths into one restart', async () => {
    let releaseRestart!: () => void
    const restartGate = new Promise<void>((resolve) => {
      releaseRestart = resolve
    })
    const deps = createDeps()
    deps.restartAgent.mockImplementation(() => restartGate)
    deps.observeUnexpectedDeath.mockResolvedValue({
      action: 'recover',
      reason: 'runtime_lost',
      replaceGeneration: true,
    })

    const first = recoverFromUnexpectedDeath(deps)
    const second = recoverFromUnexpectedDeath(deps)
    releaseRestart()
    await Promise.all([first, second])

    expect(deps.restartAgent).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('settles as session_error when resume send fails', async () => {
    const deps = createDeps()
    deps.observeUnexpectedDeath.mockResolvedValue({
      action: 'recover',
      reason: 'runtime_lost',
      replaceGeneration: true,
    })
    deps.sendMessage.mockRejectedValue(new Error('send failed'))

    await recoverFromUnexpectedDeath(deps)

    expect(deps.settleRecoveringSessions).toHaveBeenCalledWith(['sess-1'])
    expect(deps.releaseRecovery).not.toHaveBeenCalled()
  })

  it('coalesces a user message onto the same resume send', async () => {
    const deps = createDeps({
      takeCoalescedUserMessage: () => 'keep going',
    })
    deps.observeUnexpectedDeath.mockResolvedValue({
      action: 'recover',
      reason: 'runtime_lost',
      replaceGeneration: true,
    })

    await recoverFromUnexpectedDeath(deps)

    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage.mock.calls[0][1]).toBe(
      `${RECOVERY_PROMPTS.runtime_lost}\n\nThe user also sent:\nkeep going`,
    )
  })
})
