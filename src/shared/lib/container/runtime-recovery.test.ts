import { describe, expect, it, vi, beforeEach } from 'vitest'
import { addErrorBreadcrumb, captureException } from '@shared/lib/error-reporting'
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

const MAX_LIFETIME_PROMPT =
  'The previous turn was cut off because the runtime hit its 8-hour lifetime. Continue from where you left off. Check what already completed before redoing work.'
const RUNTIME_LOST_PROMPT =
  'The previous turn was interrupted because the runtime stopped unexpectedly. Continue from where you left off.'
const GUEST_OOM_PROMPT =
  'The previous turn was killed because the process ran out of memory. Continue from where you left off.'

function recoverPlan(overrides: Partial<Extract<UnexpectedDeathPlan, { action: 'recover' }>> = {}) {
  return {
    action: 'recover' as const,
    reason: 'runtime_lost',
    resumePrompt: RUNTIME_LOST_PROMPT,
    replaceGeneration: true,
    ...overrides,
  }
}

function createDeps(overrides: Partial<RuntimeRecoveryDeps> = {}): RuntimeRecoveryDeps & {
  restartAgent: ReturnType<typeof vi.fn>
  ensureRunning: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  observeUnexpectedDeath: ReturnType<typeof vi.fn>
  settleRecoveringSessions: ReturnType<typeof vi.fn>
  markRecovered: ReturnType<typeof vi.fn>
  subscribeToSession: ReturnType<typeof vi.fn>
  onIdleDeath: ReturnType<typeof vi.fn>
} {
  const sendMessage = vi.fn().mockResolvedValue(undefined)
  const observeUnexpectedDeath = vi.fn<(input?: unknown) => Promise<UnexpectedDeathPlan>>()
  observeUnexpectedDeath.mockResolvedValue({ action: 'settle' })
  const restartAgent = vi.fn().mockResolvedValue(undefined)
  const ensureRunning = vi.fn()
  const settleRecoveringSessions = vi.fn()
  const markRecovered = vi.fn()
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
    markRecovered: (ids) => {
      markRecovered(ids)
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
    markRecovered,
    subscribeToSession,
    onIdleDeath,
  }
}

describe('recoverFromUnexpectedDeath', () => {
  beforeEach(() => {
    resetRuntimeRecoveryForTests()
    vi.clearAllMocks()
  })

  it('restarts once and resumes mid-turn sessions with the plan-provided prompt', async () => {
    const deps = createDeps()
    deps.observeUnexpectedDeath.mockResolvedValue(
      recoverPlan({ reason: 'max_lifetime', resumePrompt: MAX_LIFETIME_PROMPT }),
    )

    await recoverFromUnexpectedDeath(deps)

    expect(deps.restartAgent).toHaveBeenCalledTimes(1)
    expect(deps.ensureRunning).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage.mock.calls[0][0]).toBe('sess-1')
    expect(deps.sendMessage.mock.calls[0][1]).toBe(MAX_LIFETIME_PROMPT)
    expect(deps.sendMessage.mock.calls[0][3]).toEqual({ shouldQuery: true })
    expect(deps.markRecovered).toHaveBeenCalledWith(['sess-1'])
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
    deps.observeUnexpectedDeath.mockResolvedValue(
      recoverPlan({
        reason: 'guest_oom',
        resumePrompt: GUEST_OOM_PROMPT,
        replaceGeneration: false,
      }),
    )

    await recoverFromUnexpectedDeath(deps)

    expect(deps.restartAgent).not.toHaveBeenCalled()
    expect(deps.ensureRunning).not.toHaveBeenCalled()
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'sess-1',
      GUEST_OOM_PROMPT,
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
    expect(deps.markRecovered).toHaveBeenCalledWith(['sess-1'])
    expect(deps.settleRecoveringSessions).not.toHaveBeenCalled()
    expect(deps.subscribeToSession).toHaveBeenCalled()
  })

  it('delivers a coalesced user message to the live session on ignore', async () => {
    const deps = createDeps({
      takeCoalescedUserMessage: (id) => (id === 'sess-1' ? 'keep going' : undefined),
    })
    deps.observeUnexpectedDeath.mockResolvedValue({ action: 'ignore' })

    await recoverFromUnexpectedDeath(deps)

    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage).toHaveBeenCalledWith('sess-1', 'keep going', expect.any(String), {
      shouldQuery: true,
    })
  })

  it('does not resume when the agent is stopping', async () => {
    const deps = createDeps({ isStopping: () => true })
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())

    await recoverFromUnexpectedDeath(deps)

    expect(deps.restartAgent).not.toHaveBeenCalled()
    expect(deps.sendMessage).not.toHaveBeenCalled()
    expect(deps.settleRecoveringSessions).not.toHaveBeenCalled()
  })

  it('does not resume idle sessions', async () => {
    const deps = createDeps({
      snapshotMidTurnSessions: () => [],
    })
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())

    await recoverFromUnexpectedDeath(deps)

    expect(deps.onIdleDeath).toHaveBeenCalledTimes(1)
    expect(deps.restartAgent).not.toHaveBeenCalled()
    expect(deps.sendMessage).not.toHaveBeenCalled()
    expect(deps.observeUnexpectedDeath).not.toHaveBeenCalled()
  })

  it('single-flights concurrent deaths and re-runs once for the joined signal', async () => {
    let releaseRestart!: () => void
    const restartGate = new Promise<void>((resolve) => {
      releaseRestart = resolve
    })
    const snapshots: number[] = []
    const recovering = new Set<string>()
    let call = 0
    const deps = createDeps({
      snapshotMidTurnSessions: () => {
        call += 1
        snapshots.push(call)
        // First run recovers sess-1; the queued re-run finds nothing mid-turn.
        if (call === 1) {
          recovering.add('sess-1')
          return ['sess-1']
        }
        return []
      },
      isSessionRecovering: (id) => recovering.has(id),
    })
    deps.restartAgent.mockImplementation(() => restartGate)
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())

    const first = recoverFromUnexpectedDeath(deps)
    const second = recoverFromUnexpectedDeath(deps)
    releaseRestart()
    await Promise.all([first, second])
    await new Promise((r) => setTimeout(r, 0))

    expect(deps.restartAgent).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
    // The joined death signal triggered exactly one follow-up snapshot.
    expect(snapshots).toEqual([1, 2])
  })

  it('settles as session_error when resume send fails', async () => {
    const deps = createDeps()
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())
    deps.sendMessage.mockRejectedValue(new Error('send failed'))

    await recoverFromUnexpectedDeath(deps)

    expect(deps.settleRecoveringSessions).toHaveBeenCalledWith(['sess-1'])
    expect(deps.markRecovered).not.toHaveBeenCalled()
  })

  it('settles when observeUnexpectedDeath rejects', async () => {
    const deps = createDeps()
    deps.observeUnexpectedDeath.mockRejectedValue(new Error('observe failed'))

    await recoverFromUnexpectedDeath(deps)

    expect(deps.settleRecoveringSessions).toHaveBeenCalledWith(['sess-1'])
    expect(deps.restartAgent).not.toHaveBeenCalled()
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { area: 'container', op: 'runtime.observeDeath' } }),
    )
  })

  it('coalesces a user message onto the same resume send', async () => {
    const deps = createDeps({
      takeCoalescedUserMessage: () => 'keep going',
    })
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())

    await recoverFromUnexpectedDeath(deps)

    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage.mock.calls[0][1]).toBe(
      `${RUNTIME_LOST_PROMPT}\n\nThe user also sent:\nkeep going`,
    )
  })

  it('settles instead of recovering once the crash-loop budget is exhausted', async () => {
    const deps = createDeps()
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())

    for (let i = 0; i < 3; i++) {
      await recoverFromUnexpectedDeath(deps)
    }
    expect(deps.settleRecoveringSessions).not.toHaveBeenCalled()
    expect(deps.sendMessage).toHaveBeenCalledTimes(3)

    await recoverFromUnexpectedDeath(deps)

    expect(deps.sendMessage).toHaveBeenCalledTimes(3)
    expect(deps.settleRecoveringSessions).toHaveBeenCalledWith(['sess-1'])
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { area: 'container', op: 'runtime.recover.budget' } }),
    )
  })
})
