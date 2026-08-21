import { describe, expect, it, vi, beforeEach } from 'vitest'
import { addErrorBreadcrumb, captureException } from '@shared/lib/error-reporting'
import {
  recoverFromUnexpectedDeath,
  resetRuntimeRecoveryForTests,
  type RuntimeRecoveryDeps,
} from './runtime-recovery'
import type { ContainerClient } from './types'
import type { CoalescedUserMessage, UnexpectedDeathPlan } from './runtime-death'

vi.mock('@shared/lib/error-reporting', () => ({
  addErrorBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}))

// The orchestrator treats reason and resumePrompt as opaque runtime-provided
// values, so these are deliberately synthetic. Real wording lives in each runtime.
const TEST_REASON = 'test-death-reason'
const TEST_RESUME_PROMPT = 'test resume prompt from the runtime'
const TEST_MESSAGE_UUID = '11111111-1111-4111-8111-111111111111'

function recoverPlan(overrides: Partial<Extract<UnexpectedDeathPlan, { action: 'recover' }>> = {}) {
  return {
    action: 'recover' as const,
    reason: TEST_REASON,
    resumePrompt: TEST_RESUME_PROMPT,
    replaceGeneration: true,
    ...overrides,
  }
}

function coalescedKeepGoing(): CoalescedUserMessage[] {
  return [{ uuid: TEST_MESSAGE_UUID, text: 'keep going' }]
}

function createDeps(overrides: Partial<RuntimeRecoveryDeps> = {}): RuntimeRecoveryDeps & {
  restartAgent: ReturnType<typeof vi.fn>
  ensureRunning: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  observeUnexpectedDeath: ReturnType<typeof vi.fn>
  settleRecoveringSessions: ReturnType<typeof vi.fn>
  markRecovered: ReturnType<typeof vi.fn>
  subscribeToSession: ReturnType<typeof vi.fn>
  syncAgentStatus: ReturnType<typeof vi.fn>
} {
  const sendMessage = vi.fn().mockResolvedValue(undefined)
  const observeUnexpectedDeath = vi.fn<(input?: unknown) => Promise<UnexpectedDeathPlan>>()
  observeUnexpectedDeath.mockResolvedValue({ action: 'settle' })
  const restartAgent = vi.fn().mockResolvedValue(undefined)
  const ensureRunning = vi.fn()
  const settleRecoveringSessions = vi.fn()
  const markRecovered = vi.fn()
  const subscribeToSession = vi.fn().mockResolvedValue(undefined)
  const syncAgentStatus = vi.fn().mockResolvedValue(undefined)
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
    takeCoalescedUserMessages: () => [],
    isSessionRecovering: (id) => recovering.has(id),
    isSubscribed: () => false,
    subscribeToSession,
    syncAgentStatus,
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
    syncAgentStatus,
  }
}

describe('recoverFromUnexpectedDeath', () => {
  beforeEach(() => {
    resetRuntimeRecoveryForTests()
    vi.clearAllMocks()
  })

  it('restarts once when replaceGeneration is true and resumes with the plan-provided prompt', async () => {
    const deps = createDeps()
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())

    await recoverFromUnexpectedDeath(deps)

    expect(deps.restartAgent).toHaveBeenCalledTimes(1)
    expect(deps.ensureRunning).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage.mock.calls[0][0]).toBe('sess-1')
    expect(deps.sendMessage.mock.calls[0][1]).toBe(TEST_RESUME_PROMPT)
    expect(deps.sendMessage.mock.calls[0][3]).toEqual({ shouldQuery: true })
    expect(deps.markRecovered).toHaveBeenCalledWith(['sess-1'])
    expect(deps.settleRecoveringSessions).not.toHaveBeenCalled()
    expect(deps.syncAgentStatus).not.toHaveBeenCalled()
    expect(addErrorBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentId: 'agent-1',
          reason: TEST_REASON,
          replaceGeneration: true,
          sessionIds: ['sess-1'],
          oldGenerationId: 'mvm-old',
          newGenerationId: 'mvm-new',
        }),
      }),
    )
  })

  it('reuses the current client when replaceGeneration is false and forwards the last fatal', async () => {
    const deps = createDeps({
      consumeLastFatal: () => 'oom_sigkill',
    })
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan({ replaceGeneration: false }))

    await recoverFromUnexpectedDeath(deps)

    expect(deps.restartAgent).not.toHaveBeenCalled()
    expect(deps.ensureRunning).not.toHaveBeenCalled()
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'sess-1',
      TEST_RESUME_PROMPT,
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
    expect(deps.syncAgentStatus).not.toHaveBeenCalled()
    expect(deps.subscribeToSession).toHaveBeenCalled()
  })

  it('delivers a coalesced user message to the live session on ignore with its original uuid', async () => {
    const deps = createDeps({
      takeCoalescedUserMessages: (id) => (id === 'sess-1' ? coalescedKeepGoing() : []),
    })
    deps.observeUnexpectedDeath.mockResolvedValue({ action: 'ignore' })

    await recoverFromUnexpectedDeath(deps)

    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage).toHaveBeenCalledWith('sess-1', 'keep going', TEST_MESSAGE_UUID, {
      shouldQuery: true,
    })
  })

  it('settles only the sessions the runtime did not report as live', async () => {
    const recovering = new Set(['sess-1', 'sess-2'])
    const deps = createDeps({
      snapshotMidTurnSessions: () => {
        recovering.add('sess-1')
        recovering.add('sess-2')
        return ['sess-1', 'sess-2']
      },
      isSessionRecovering: (id) => recovering.has(id),
      takeCoalescedUserMessages: (id) => (id === 'sess-1' ? coalescedKeepGoing() : []),
    })
    deps.observeUnexpectedDeath.mockResolvedValue({ action: 'ignore', liveSessionIds: ['sess-1'] })

    await recoverFromUnexpectedDeath(deps)

    expect(deps.settleRecoveringSessions).toHaveBeenCalledWith(['sess-2'])
    expect(deps.markRecovered).toHaveBeenCalledWith(['sess-1'])
    expect(deps.sendMessage).toHaveBeenCalledWith('sess-1', 'keep going', TEST_MESSAGE_UUID, {
      shouldQuery: true,
    })
    expect(deps.syncAgentStatus).toHaveBeenCalledTimes(1)
  })

  it('settles mid-turn sessions when the agent is already stopping', async () => {
    const deps = createDeps({ isStopping: () => true })
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())

    await recoverFromUnexpectedDeath(deps)

    expect(deps.restartAgent).not.toHaveBeenCalled()
    expect(deps.sendMessage).not.toHaveBeenCalled()
    expect(deps.observeUnexpectedDeath).not.toHaveBeenCalled()
    expect(deps.settleRecoveringSessions).toHaveBeenCalledWith(['sess-1'])
    expect(deps.syncAgentStatus).toHaveBeenCalledTimes(1)
  })

  it('snapshots only the scoped session ids', async () => {
    const snapshot = vi.fn(() => ['sess-1'])
    const deps = createDeps({
      restrictToSessionIds: ['sess-1'],
      snapshotMidTurnSessions: snapshot,
    })
    deps.observeUnexpectedDeath.mockResolvedValue({ action: 'settle' })

    await recoverFromUnexpectedDeath(deps)

    expect(snapshot).toHaveBeenCalledWith('agent-1', ['sess-1'])
  })

  it('does not resume idle sessions', async () => {
    const deps = createDeps({
      snapshotMidTurnSessions: () => [],
    })
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())

    await recoverFromUnexpectedDeath(deps)

    expect(deps.syncAgentStatus).toHaveBeenCalledTimes(1)
    expect(deps.restartAgent).not.toHaveBeenCalled()
    expect(deps.sendMessage).not.toHaveBeenCalled()
    expect(deps.observeUnexpectedDeath).not.toHaveBeenCalled()
  })

  it('consumes a recorded fatal even when the snapshot is empty', async () => {
    const consumeLastFatal = vi.fn(() => 'oom_sigkill' as const)
    const deps = createDeps({
      snapshotMidTurnSessions: () => [],
      consumeLastFatal,
    })

    await recoverFromUnexpectedDeath(deps)

    expect(consumeLastFatal).toHaveBeenCalledTimes(1)
  })

  it('captures a queued re-run that rejects instead of leaving it unhandled', async () => {
    let releaseRestart!: () => void
    const restartGate = new Promise<void>((resolve) => {
      releaseRestart = resolve
    })
    let call = 0
    const deps = createDeps({
      snapshotMidTurnSessions: () => {
        call += 1
        if (call === 1) return ['sess-1']
        throw new Error('snapshot exploded on re-run')
      },
    })
    deps.restartAgent.mockImplementation(() => restartGate)
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())

    const first = recoverFromUnexpectedDeath(deps)
    const second = recoverFromUnexpectedDeath(deps)
    releaseRestart()
    await Promise.all([first, second])
    await new Promise((r) => setTimeout(r, 0))

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { area: 'container', op: 'runtime.recover.rerun' } }),
    )
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

  it('widens a queued session-scoped death to agent-wide when a later signal is unscoped', async () => {
    let releaseObserve!: () => void
    const observeGate = new Promise<void>((resolve) => {
      releaseObserve = resolve
    })
    const snapshotArgs: Array<string[] | undefined> = []
    const deps = createDeps({
      restrictToSessionIds: ['sess-1'],
      snapshotMidTurnSessions: (_slug, restrict) => {
        snapshotArgs.push(restrict)
        return ['sess-1']
      },
    })
    deps.observeUnexpectedDeath.mockImplementation(async () => {
      await observeGate
      return { action: 'ignore' }
    })

    const first = recoverFromUnexpectedDeath(deps)
    const second = recoverFromUnexpectedDeath({ ...deps, restrictToSessionIds: undefined })
    releaseObserve()
    await Promise.all([first, second])
    await new Promise((r) => setTimeout(r, 0))

    expect(snapshotArgs).toEqual([['sess-1'], undefined])
  })

  it('settles remaining recovering sessions when ignore delivery throws', async () => {
    const deps = createDeps()
    deps.markRecovered.mockImplementation(() => {
      throw new Error('markRecovered failed')
    })
    deps.observeUnexpectedDeath.mockResolvedValue({ action: 'ignore' })

    await recoverFromUnexpectedDeath(deps)

    expect(deps.settleRecoveringSessions).toHaveBeenCalledWith(['sess-1'])
    expect(deps.syncAgentStatus).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { area: 'container', op: 'runtime.recover.ignore' } }),
    )
  })

  it('settles as session_error when resume send fails', async () => {
    const deps = createDeps()
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())
    deps.sendMessage.mockRejectedValue(new Error('send failed'))

    await recoverFromUnexpectedDeath(deps)

    expect(deps.settleRecoveringSessions).toHaveBeenCalledWith(['sess-1'])
    expect(deps.markRecovered).not.toHaveBeenCalled()
    expect(deps.syncAgentStatus).toHaveBeenCalledTimes(1)
  })

  it('settles when observeUnexpectedDeath rejects', async () => {
    const deps = createDeps()
    deps.observeUnexpectedDeath.mockRejectedValue(new Error('observe failed'))

    await recoverFromUnexpectedDeath(deps)

    expect(deps.settleRecoveringSessions).toHaveBeenCalledWith(['sess-1'])
    expect(deps.restartAgent).not.toHaveBeenCalled()
    expect(deps.syncAgentStatus).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { area: 'container', op: 'runtime.observeDeath' } }),
    )
  })

  it('sends the resume prompt first, then each coalesced user message with its uuid', async () => {
    const deps = createDeps({
      takeCoalescedUserMessages: () => coalescedKeepGoing(),
    })
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())

    await recoverFromUnexpectedDeath(deps)

    expect(deps.sendMessage).toHaveBeenCalledTimes(2)
    expect(deps.sendMessage.mock.calls[0][1]).toBe(TEST_RESUME_PROMPT)
    expect(deps.sendMessage.mock.calls[1]).toEqual([
      'sess-1',
      'keep going',
      TEST_MESSAGE_UUID,
      { shouldQuery: true },
    ])
    expect(deps.syncAgentStatus).not.toHaveBeenCalled()
  })

  it('settles instead of recovering once the crash-loop budget is exhausted', async () => {
    const deps = createDeps()
    deps.observeUnexpectedDeath.mockResolvedValue(recoverPlan())

    for (let i = 0; i < 5; i++) {
      await recoverFromUnexpectedDeath(deps)
    }
    expect(deps.settleRecoveringSessions).not.toHaveBeenCalled()
    expect(deps.sendMessage).toHaveBeenCalledTimes(5)

    await recoverFromUnexpectedDeath(deps)

    expect(deps.sendMessage).toHaveBeenCalledTimes(5)
    expect(deps.settleRecoveringSessions).toHaveBeenCalledWith(['sess-1'])
    expect(deps.syncAgentStatus).toHaveBeenCalledTimes(1)
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { area: 'container', op: 'runtime.recover.budget' } }),
    )
  })

  it('syncs agent status when the plan is settle', async () => {
    const deps = createDeps()
    deps.observeUnexpectedDeath.mockResolvedValue({ action: 'settle' })

    await recoverFromUnexpectedDeath(deps)

    expect(deps.settleRecoveringSessions).toHaveBeenCalledWith(['sess-1'])
    expect(deps.syncAgentStatus).toHaveBeenCalledTimes(1)
    expect(deps.sendMessage).not.toHaveBeenCalled()
  })
})
