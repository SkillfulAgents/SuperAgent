import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockAddWakeTarget = vi.fn()
const mockSettleWakeTarget = vi.fn()
const mockMarkWakeDueIfSettled = vi.fn()
const mockListPendingEventWakes = vi.fn()
vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  addWakeTarget: (...args: unknown[]) => mockAddWakeTarget(...args),
  settleWakeTarget: (...args: unknown[]) => mockSettleWakeTarget(...args),
  markWakeDueIfSettled: (...args: unknown[]) => mockMarkWakeDueIfSettled(...args),
  listPendingEventWakes: (...args: unknown[]) => mockListPendingEventWakes(...args),
}))

let globalClient: ((event: unknown) => void) | null = null
const mockIsSessionActive = vi.fn((..._args: unknown[]) => false)
const mockIsSessionAwaitingInput = vi.fn((..._args: unknown[]) => false)
const mockIsSessionRecovering = vi.fn((..._args: unknown[]) => false)
const mockMarkSessionActive = vi.fn((..._args: unknown[]) => undefined)
const mockIsSubscribed = vi.fn((..._args: unknown[]) => false)
const mockSubscribeToSession = vi.fn(async (..._args: unknown[]) => {})
const mockBroadcastGlobal = vi.fn()
const mockBroadcastSessionUpdate = vi.fn()
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    addGlobalNotificationClient: (cb: (event: unknown) => void) => {
      globalClient = cb
      return () => { globalClient = null }
    },
    isSessionActive: (id: string) => mockIsSessionActive(id),
    isSessionAwaitingInput: (id: string) => mockIsSessionAwaitingInput(id),
    isSessionRecovering: (id: string) => mockIsSessionRecovering(id),
    markSessionActive: (...args: unknown[]) => mockMarkSessionActive(...args),
    isSubscribed: (...args: unknown[]) => mockIsSubscribed(...args),
    subscribeToSession: (...args: unknown[]) => mockSubscribeToSession(...args),
    broadcastGlobal: (...args: unknown[]) => mockBroadcastGlobal(...args),
    broadcastSessionUpdate: (...args: unknown[]) => mockBroadcastSessionUpdate(...args),
  },
}))

const mockSyncAgentStatus = vi.fn()
const mockGetSession = vi.fn()
const fakeClient = { getSession: (...args: unknown[]) => mockGetSession(...args) }
vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    syncAgentStatus: (...args: unknown[]) => mockSyncAgentStatus(...args),
    getClient: () => fakeClient,
  },
}))

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import { invokedSessionListener, isCallerIdle, setKickDueWakes, trackInvokedSession } from './invoked-session-listener'

async function emit(event: unknown) {
  globalClient?.(event)
  // handlers are fire-and-forget; let the promise chain settle
  await new Promise((r) => setTimeout(r, 0))
}

describe('invokedSessionListener', () => {
  const kickDue = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    invokedSessionListener.stop()
    setKickDueWakes(kickDue)
    mockSettleWakeTarget.mockResolvedValue([])
    mockMarkWakeDueIfSettled.mockResolvedValue(false)
    mockAddWakeTarget.mockResolvedValue({ taskId: 't1' })
    mockListPendingEventWakes.mockResolvedValue([])
    mockIsSessionActive.mockReturnValue(false)
    mockIsSessionAwaitingInput.mockReturnValue(false)
    invokedSessionListener.start()
  })

  afterEach(() => {
    setKickDueWakes(null)
  })

  it('settles on session_idle as completed and re-checks the idle session as a caller', async () => {
    await emit({ type: 'session_idle', sessionId: 'sess-b', agentSlug: 'agent-b', isActive: false })
    expect(mockSettleWakeTarget).toHaveBeenCalledWith({
      targetSessionId: 'sess-b',
      outcome: 'completed',
      callerIdle: isCallerIdle,
    })
    expect(mockMarkWakeDueIfSettled).toHaveBeenCalledWith('sess-b')
    expect(kickDue).not.toHaveBeenCalled()
  })

  it('kicks the due-task scan when the last target finishes and the caller is idle', async () => {
    mockSettleWakeTarget.mockResolvedValue(['wake-1'])
    await emit({ type: 'session_idle', sessionId: 'sess-b', agentSlug: 'agent-b', isActive: false })
    expect(kickDue).toHaveBeenCalledTimes(1)
  })

  it('kicks the due-task scan when the caller goes idle on an already-due row', async () => {
    mockMarkWakeDueIfSettled.mockResolvedValue(true)
    await emit({ type: 'session_idle', sessionId: 'sess-a', agentSlug: 'agent-a', isActive: false })
    expect(kickDue).toHaveBeenCalledTimes(1)
  })

  it('settles on session_error as errored', async () => {
    await emit({ type: 'session_error', sessionId: 'sess-b', agentSlug: 'agent-b' })
    expect(mockSettleWakeTarget).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: 'sess-b', outcome: 'errored' }))
  })

  it('ignores other events', async () => {
    await emit({ type: 'session_updated', sessionId: 'sess-b' })
    expect(mockSettleWakeTarget).not.toHaveBeenCalled()
    expect(mockMarkWakeDueIfSettled).not.toHaveBeenCalled()
  })

  it('start is idempotent and stop unsubscribes', async () => {
    invokedSessionListener.start()
    invokedSessionListener.stop()
    expect(globalClient).toBeNull()
  })
})

describe('isCallerIdle', () => {
  it('is false while active or awaiting input', () => {
    mockIsSessionActive.mockReturnValue(true)
    expect(isCallerIdle('a')).toBe(false)
    mockIsSessionActive.mockReturnValue(false)
    mockIsSessionAwaitingInput.mockReturnValue(true)
    expect(isCallerIdle('a')).toBe(false)
    mockIsSessionAwaitingInput.mockReturnValue(false)
    expect(isCallerIdle('a')).toBe(true)
  })
})

describe('trackInvokedSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAddWakeTarget.mockResolvedValue({ taskId: 't1' })
    mockSettleWakeTarget.mockResolvedValue([])
  })

  it('adds the target and leaves it open while the target is active', async () => {
    mockIsSessionActive.mockImplementation((id: unknown) => id === 'sess-b')
    await trackInvokedSession({ callerAgentSlug: 'a', callerSessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b', boundaryUuid: 'u' } })
    expect(mockAddWakeTarget).toHaveBeenCalledWith({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b', boundaryUuid: 'u' }, createdByUserId: undefined })
    expect(mockSettleWakeTarget).not.toHaveBeenCalled()
  })

  it('notifies the open session so the wake banner can refetch', async () => {
    mockIsSessionActive.mockImplementation((id: unknown) => id === 'sess-b')
    await trackInvokedSession({ callerAgentSlug: 'a', callerSessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b' } })
    expect(mockBroadcastGlobal).toHaveBeenCalledWith({
      type: 'session_updated',
      sessionId: 'sess-a',
      agentSlug: 'a',
    })
    expect(mockBroadcastSessionUpdate).toHaveBeenCalledWith('sess-a')
  })

  it('settles immediately when the target already went idle (fast B)', async () => {
    mockIsSessionActive.mockReturnValue(false)
    await trackInvokedSession({ callerAgentSlug: 'a', callerSessionId: 'sess-a', createdByUserId: 'u-1', target: { agentSlug: 'b', sessionId: 'sess-fast-b' } })
    expect(mockSettleWakeTarget).toHaveBeenCalledWith({ targetSessionId: 'sess-fast-b', outcome: 'completed', callerIdle: isCallerIdle })
  })

  it('kicks the due-task scan when a fast target settles and the caller is idle', async () => {
    const kickDue = vi.fn()
    setKickDueWakes(kickDue)
    mockIsSessionActive.mockReturnValue(false)
    mockSettleWakeTarget.mockResolvedValue(['wake-1'])
    await trackInvokedSession({ callerAgentSlug: 'a', callerSessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-fast-b' } })
    expect(kickDue).toHaveBeenCalledTimes(1)
    setKickDueWakes(null)
  })

  it('settles with the error the listener just saw (fast error before the row existed)', async () => {
    invokedSessionListener.start()
    await emit({ type: 'session_error', sessionId: 'sess-b', agentSlug: 'b' })
    mockSettleWakeTarget.mockClear()
    mockIsSessionActive.mockReturnValue(false)
    await trackInvokedSession({ callerAgentSlug: 'a', callerSessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b' } })
    expect(mockSettleWakeTarget).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: 'sess-b', outcome: 'errored' }))
    invokedSessionListener.stop()
  })

  it('falls back to completed once a remembered error is older than five minutes', async () => {
    vi.useFakeTimers()
    invokedSessionListener.start()
    const seen = emit({ type: 'session_error', sessionId: 'sess-b', agentSlug: 'b' })
    await vi.advanceTimersByTimeAsync(0)
    await seen
    mockSettleWakeTarget.mockClear()
    mockIsSessionActive.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
    await trackInvokedSession({ callerAgentSlug: 'a', callerSessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b' } })
    expect(mockSettleWakeTarget).toHaveBeenCalledWith(expect.objectContaining({
      targetSessionId: 'sess-b',
      outcome: 'completed',
    }))
    invokedSessionListener.stop()
    vi.useRealTimers()
  })
})

describe('reconcileAtBoot', () => {
  const row = (targets: unknown[]) => ({
    id: 't1', agentSlug: 'a', resumeSessionId: 'sess-a', status: 'pending',
    wakeOnSessions: JSON.stringify({ targets }),
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockSettleWakeTarget.mockResolvedValue([])
    mockMarkWakeDueIfSettled.mockResolvedValue(false)
    mockIsSessionRecovering.mockReturnValue(false)
  })

  it('marks a target unknown when its container is down', async () => {
    mockListPendingEventWakes.mockResolvedValue([row([{ agentSlug: 'b', sessionId: 'sess-b' }])])
    mockSyncAgentStatus.mockResolvedValue({ status: 'stopped' })
    await invokedSessionListener.reconcileAtBoot()
    expect(mockSettleWakeTarget).toHaveBeenCalledWith(expect.objectContaining({ targetSessionId: 'sess-b', outcome: 'unknown' }))
    expect(mockMarkWakeDueIfSettled).toHaveBeenCalledWith('sess-a')
  })

  it('marks active and subscribes when the target is still running', async () => {
    mockListPendingEventWakes.mockResolvedValue([row([{ agentSlug: 'b', sessionId: 'sess-b' }])])
    mockSyncAgentStatus.mockResolvedValue({ status: 'running' })
    mockGetSession.mockResolvedValue({ id: 'sess-b', isRunning: true })
    await invokedSessionListener.reconcileAtBoot()
    expect(mockMarkSessionActive).toHaveBeenCalledWith('sess-b', 'b')
    expect(mockSubscribeToSession).toHaveBeenCalledWith('sess-b', fakeClient, 'sess-b', 'b')
    expect(mockMarkSessionActive.mock.invocationCallOrder[0]).toBeLessThan(mockSubscribeToSession.mock.invocationCallOrder[0])
    expect(mockSettleWakeTarget).not.toHaveBeenCalled()
  })

  it('skips already-stamped targets', async () => {
    mockListPendingEventWakes.mockResolvedValue([row([{ agentSlug: 'b', sessionId: 'sess-b', outcome: 'completed' }])])
    await invokedSessionListener.reconcileAtBoot()
    expect(mockSyncAgentStatus).not.toHaveBeenCalled()
    expect(mockMarkWakeDueIfSettled).toHaveBeenCalledWith('sess-a')
  })
})
