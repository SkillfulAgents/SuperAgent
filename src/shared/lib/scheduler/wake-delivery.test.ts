import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'

const mockGetScheduledTask = vi.fn()
const mockMarkTaskExecuted = vi.fn()
const mockAddWakeTarget = vi.fn()
const mockCreateSessionWake = vi.fn()

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getScheduledTask: (...args: unknown[]) => mockGetScheduledTask(...args),
  markTaskExecuted: (...args: unknown[]) => mockMarkTaskExecuted(...args),
  addWakeTarget: (...args: unknown[]) => mockAddWakeTarget(...args),
  createSessionWake: (...args: unknown[]) => mockCreateSessionWake(...args),
}))

const mockSendMessage = vi.fn()
const mockEnsureRunning = vi.fn()

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    ensureRunning: (...args: unknown[]) => mockEnsureRunning(...args),
  },
}))

const mockSubscribeToSession = vi.fn()
const mockMarkSessionActive = vi.fn()
const mockMarkSessionIdle = vi.fn()
const mockIsSubscribed = vi.fn()
const mockCancelAwaitingInput = vi.fn()
const mockBroadcastGlobal = vi.fn()
const mockBroadcastSessionUpdate = vi.fn()
const mockIsSessionActive = vi.fn((..._args: unknown[]) => false)
const mockIsSessionAwaitingInput = vi.fn((..._args: unknown[]) => false)

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    subscribeToSession: (...args: unknown[]) => mockSubscribeToSession(...args),
    markSessionActive: (...args: unknown[]) => mockMarkSessionActive(...args),
    markSessionIdle: (...args: unknown[]) => mockMarkSessionIdle(...args),
    isSubscribed: (...args: unknown[]) => mockIsSubscribed(...args),
    cancelAwaitingInput: (...args: unknown[]) => mockCancelAwaitingInput(...args),
    broadcastGlobal: (...args: unknown[]) => mockBroadcastGlobal(...args),
    broadcastSessionUpdate: (...args: unknown[]) => mockBroadcastSessionUpdate(...args),
    isSessionActive: (...args: unknown[]) => mockIsSessionActive(...args),
    isSessionAwaitingInput: (...args: unknown[]) => mockIsSessionAwaitingInput(...args),
  },
}))

const mockBuildWakeMessage = vi.fn(async (..._args: unknown[]) => '[SYSTEM] wake')
vi.mock('./wake-message', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./wake-message')>()
  return {
    ...actual,
    buildWakeMessage: (...args: unknown[]) => mockBuildWakeMessage(...args),
  }
})

const mockTrackInvokedSession = vi.fn(async (..._args: unknown[]) => {})
vi.mock('./invoked-session-listener', () => ({
  trackInvokedSession: (...args: unknown[]) => mockTrackInvokedSession(...args),
  isCallerIdle: (id: string) => !mockIsSessionActive(id) && !mockIsSessionAwaitingInput(id),
}))

const mockTriggerScheduledSessionResumed = vi.fn()

vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerScheduledSessionResumed: (...args: unknown[]) =>
      mockTriggerScheduledSessionResumed(...args),
  },
}))

const mockGetSessionMetadata = vi.fn()
const mockUpdateSessionMetadata = vi.fn()

vi.mock('@shared/lib/services/session-service', () => ({
  getSessionMetadata: (...args: unknown[]) => mockGetSessionMetadata(...args),
  updateSessionMetadata: (...args: unknown[]) => mockUpdateSessionMetadata(...args),
}))

const mockAgentExists = vi.fn()

vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: (...args: unknown[]) => mockAgentExists(...args),
}))

import { deliverSessionWake } from './wake-delivery'

const wakeExecutionAt = new Date('2026-06-26T17:00:00.000Z')

function createWakeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'wake-task-1',
    agentSlug: 'agent-one',
    scheduleType: 'at',
    scheduleExpression: 'at tomorrow 9am',
    prompt: 'Check whether Dana replied',
    name: null,
    status: 'pending',
    nextExecutionAt: wakeExecutionAt,
    lastExecutedAt: null,
    isRecurring: false,
    executionCount: 0,
    lastSessionId: null,
    createdBySessionId: 'sleeping-session-1',
    createdByUserId: null,
    timezone: null,
    model: null,
    effort: null,
    speed: null,
    resumeSessionId: 'sleeping-session-1',
    wakeOnSessions: null,
    createdAt: new Date('2026-06-25T16:00:00.000Z'),
    cancelledAt: null,
    pausedAt: null,
    ...overrides,
  }
}

describe('deliverSessionWake', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetScheduledTask.mockImplementation(async () => createWakeTask())
    mockMarkTaskExecuted.mockResolvedValue(undefined)
    mockEnsureRunning.mockResolvedValue({ sendMessage: mockSendMessage })
    mockSendMessage.mockResolvedValue(undefined)
    mockSubscribeToSession.mockResolvedValue(undefined)
    mockIsSubscribed.mockReturnValue(false)
    mockCancelAwaitingInput.mockResolvedValue(undefined)
    mockTriggerScheduledSessionResumed.mockResolvedValue(undefined)
    mockGetSessionMetadata.mockResolvedValue({ name: 'Email follow-up' })
    mockUpdateSessionMetadata.mockResolvedValue(undefined)
    mockAgentExists.mockResolvedValue(true)
    mockAddWakeTarget.mockResolvedValue({ taskId: 'next' })
    mockCreateSessionWake.mockResolvedValue({ taskId: 'next', replaced: null, merged: false })
    mockBuildWakeMessage.mockResolvedValue('[SYSTEM] wake')
    mockTrackInvokedSession.mockResolvedValue(undefined)
    mockIsSessionActive.mockReturnValue(false)
    mockIsSessionAwaitingInput.mockReturnValue(false)
  })

  it('delivers the wake into the target session', async () => {
    const result = await deliverSessionWake(createWakeTask(), 'scheduled')

    expect(result.outcome).toBe('delivered')
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    const [sessionId, content, , options] = mockSendMessage.mock.calls[0]
    expect(sessionId).toBe('sleeping-session-1')
    expect(content.startsWith('[SYSTEM] ')).toBe(true)
    expect(options).toEqual({ shouldQuery: true })
    expect(mockUpdateSessionMetadata).toHaveBeenCalledWith(
      'agent-one',
      'sleeping-session-1',
      { lastWake: { taskId: 'wake-task-1', executionAt: wakeExecutionAt.toISOString() } }
    )
    expect(mockMarkTaskExecuted).toHaveBeenCalledWith('wake-task-1', 'sleeping-session-1')
    expect(mockTriggerScheduledSessionResumed).toHaveBeenCalled()
    expect(mockBroadcastGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session_updated', sessionId: 'sleeping-session-1' })
    )
  })

  it('does not notify on manual (Wake now) delivery', async () => {
    const result = await deliverSessionWake(createWakeTask(), 'manual')

    expect(result.outcome).toBe('delivered')
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(mockTriggerScheduledSessionResumed).not.toHaveBeenCalled()
  })

  it('only one of two simultaneous deliveries sends — the other is turned away in-flight', async () => {
    // Slow send: both callers are inside deliverSessionWake at the same time
    let releaseSend!: () => void
    mockSendMessage.mockImplementation(
      () => new Promise<void>((resolve) => { releaseSend = () => resolve() })
    )

    const task = createWakeTask()
    const first = deliverSessionWake(task, 'scheduled')
    const second = deliverSessionWake(task, 'manual')

    // The second caller bounces off the claim immediately
    const secondResult = await second
    expect(secondResult.outcome).toBe('in-flight')

    // Let the first progress through its guards to the (held) send, then release
    await vi.waitFor(() => expect(mockSendMessage).toHaveBeenCalled())
    releaseSend()
    const firstResult = await first
    expect(firstResult.outcome).toBe('delivered')
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
  })

  it('re-reads task status under the claim and skips a task that is no longer pending', async () => {
    // Caller holds a stale pending copy; the fresh read says executed
    mockGetScheduledTask.mockResolvedValue(createWakeTask({ status: 'executed' }))

    const result = await deliverSessionWake(createWakeTask(), 'scheduled')

    expect(result.outcome).toBe('not-pending')
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockMarkTaskExecuted).not.toHaveBeenCalled()
  })

  it('reconciles an already-delivered wake slot without re-sending', async () => {
    mockGetSessionMetadata.mockResolvedValue({
      name: 'Email follow-up',
      lastWake: { taskId: 'wake-task-1', executionAt: wakeExecutionAt.toISOString() },
    })

    const result = await deliverSessionWake(createWakeTask(), 'scheduled')

    expect(result.outcome).toBe('reconciled')
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockEnsureRunning).not.toHaveBeenCalled()
    expect(mockMarkTaskExecuted).toHaveBeenCalledWith('wake-task-1', 'sleeping-session-1')
  })

  it('reports a missing session without sending', async () => {
    mockGetSessionMetadata.mockResolvedValue(null)

    const result = await deliverSessionWake(createWakeTask(), 'scheduled')

    expect(result.outcome).toBe('session-missing')
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('reports a missing agent without sending', async () => {
    mockAgentExists.mockResolvedValue(false)

    const result = await deliverSessionWake(createWakeTask(), 'scheduled')

    expect(result.outcome).toBe('agent-missing')
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('reverts the optimistic active flag when the send fails, then rethrows', async () => {
    mockSendMessage.mockRejectedValue(new Error('container is restarting'))

    await expect(deliverSessionWake(createWakeTask(), 'scheduled')).rejects.toThrow(
      'container is restarting'
    )

    expect(mockMarkSessionActive).toHaveBeenCalledWith('sleeping-session-1', 'agent-one')
    expect(mockMarkSessionIdle).toHaveBeenCalledWith('sleeping-session-1')
    expect(mockMarkTaskExecuted).not.toHaveBeenCalled()
    expect(mockUpdateSessionMetadata).not.toHaveBeenCalled()
  })

  it('releases the claim after a failed delivery so the retry can proceed', async () => {
    mockSendMessage.mockRejectedValueOnce(new Error('transient'))

    await expect(deliverSessionWake(createWakeTask(), 'scheduled')).rejects.toThrow('transient')

    const retry = await deliverSessionWake(createWakeTask(), 'scheduled')
    expect(retry.outcome).toBe('delivered')
    expect(mockSendMessage).toHaveBeenCalledTimes(2)
  })

  it('re-creates a deferred timer after a target-fired wake', async () => {
    const task = createWakeTask({
      wakeOnSessions: JSON.stringify({
        targets: [{ agentSlug: 'agent-b', sessionId: 'sess-b', outcome: 'completed' }],
        deferredTimerAt: '2099-06-27T09:00:00.000Z',
      }),
    })
    mockGetScheduledTask.mockResolvedValue(task)

    const result = await deliverSessionWake(task, 'scheduled')

    expect(result.outcome).toBe('delivered')
    expect(mockMarkTaskExecuted).toHaveBeenCalledWith('wake-task-1', 'sleeping-session-1')
    expect(mockCreateSessionWake).toHaveBeenCalledWith({
      agentSlug: 'agent-one',
      scheduleExpression: 'at tomorrow 9am',
      note: 'Check whether Dana replied',
      sessionId: 'sleeping-session-1',
      createdByUserId: undefined,
      timezone: undefined,
      wakeAt: new Date('2099-06-27T09:00:00.000Z'),
    })
    expect(mockAddWakeTarget).not.toHaveBeenCalled()
  })

  it('re-creates open targets after a timer-fired wake, through the settle-if-idle path', async () => {
    const task = createWakeTask({
      wakeOnSessions: JSON.stringify({
        targets: [
          { agentSlug: 'agent-b', sessionId: 'sess-b', boundaryUuid: 'u1' },
          { agentSlug: 'agent-c', sessionId: 'sess-c', outcome: 'completed' },
        ],
      }),
    })
    mockGetScheduledTask.mockResolvedValue(task)

    await deliverSessionWake(task, 'scheduled')

    expect(mockTrackInvokedSession).toHaveBeenCalledTimes(1)
    expect(mockTrackInvokedSession).toHaveBeenCalledWith({
      callerAgentSlug: 'agent-one',
      callerSessionId: 'sleeping-session-1',
      createdByUserId: undefined,
      target: { agentSlug: 'agent-b', sessionId: 'sess-b', boundaryUuid: 'u1' },
    })
    expect(mockCreateSessionWake).not.toHaveBeenCalled()
  })

  it('builds the message before touching the parked question, so a read failure leaves it open', async () => {
    mockBuildWakeMessage.mockRejectedValueOnce(new Error('transcript unreadable'))
    const task = createWakeTask({
      wakeOnSessions: JSON.stringify({ targets: [{ agentSlug: 'agent-b', sessionId: 'sess-b', outcome: 'completed' }] }),
    })
    mockGetScheduledTask.mockResolvedValue(task)

    await expect(deliverSessionWake(task, 'scheduled')).rejects.toThrow('transcript unreadable')

    expect(mockCancelAwaitingInput).not.toHaveBeenCalled()
    expect(mockMarkSessionActive).not.toHaveBeenCalled()
    expect(mockMarkTaskExecuted).not.toHaveBeenCalled()
  })

  it('a remainder failure is logged and does not undo the delivery', async () => {
    const task = createWakeTask({
      wakeOnSessions: JSON.stringify({ targets: [{ agentSlug: 'agent-b', sessionId: 'sess-b' }] }),
    })
    mockGetScheduledTask.mockResolvedValue(task)
    mockAddWakeTarget.mockRejectedValue(new Error('disk full'))
    mockTrackInvokedSession.mockRejectedValue(new Error('disk full'))
    const result = await deliverSessionWake(task, 'scheduled')
    expect(result.outcome).toBe('delivered')
    expect(mockMarkTaskExecuted).toHaveBeenCalled()
  })

  it('uses createdAt as the dedupe slot when the row has no time', async () => {
    const task = createWakeTask({ nextExecutionAt: null, scheduleType: 'event', wakeOnSessions: JSON.stringify({ targets: [{ agentSlug: 'agent-b', sessionId: 'sess-b' }] }) })
    mockGetScheduledTask.mockResolvedValue(task)
    await deliverSessionWake(task, 'manual')
    expect(mockUpdateSessionMetadata).toHaveBeenCalledWith(
      'agent-one',
      'sleeping-session-1',
      { lastWake: { taskId: 'wake-task-1', executionAt: '2026-06-25T16:00:00.000Z' } }
    )
  })

  it('does not send after a reopen un-dues the row during the transcript read', async () => {
    const due = createWakeTask({
      scheduleType: 'event',
      wakeOnSessions: JSON.stringify({
        targets: [{ agentSlug: 'agent-b', sessionId: 'sess-b', outcome: 'completed' }],
      }),
    })
    const reopened = createWakeTask({
      scheduleType: 'event',
      nextExecutionAt: null,
      wakeOnSessions: JSON.stringify({
        targets: [{ agentSlug: 'agent-b', sessionId: 'sess-b', boundaryUuid: 'u2' }],
      }),
    })
    let row = due
    mockGetScheduledTask.mockImplementation(async () => row)

    let finishBuild!: (value: string) => void
    mockBuildWakeMessage.mockImplementation(
      () => new Promise<string>((resolve) => { finishBuild = (value) => resolve(value) })
    )

    const pending = deliverSessionWake(due, 'scheduled')
    await vi.waitFor(() => expect(mockBuildWakeMessage).toHaveBeenCalled())
    row = reopened
    finishBuild('[SYSTEM] wake')

    expect(await pending).toEqual({ outcome: 'not-due' })
    expect(mockCancelAwaitingInput).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockMarkTaskExecuted).not.toHaveBeenCalled()
  })

  it('does not send when the caller becomes active during the transcript read', async () => {
    const task = createWakeTask({
      scheduleType: 'event',
      wakeOnSessions: JSON.stringify({
        targets: [{ agentSlug: 'agent-b', sessionId: 'sess-b', outcome: 'completed' }],
      }),
    })
    mockGetScheduledTask.mockResolvedValue(task)

    let finishBuild!: (value: string) => void
    mockBuildWakeMessage.mockImplementation(
      () => new Promise<string>((resolve) => { finishBuild = (value) => resolve(value) })
    )

    const pending = deliverSessionWake(task, 'scheduled')
    await vi.waitFor(() => expect(mockBuildWakeMessage).toHaveBeenCalled())
    mockIsSessionActive.mockReturnValue(true)
    finishBuild('[SYSTEM] wake')

    expect(await pending).toEqual({ outcome: 'caller-busy' })
    expect(mockCancelAwaitingInput).not.toHaveBeenCalled()
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  it('an event winner claims the caller without cancelling a question', async () => {
    const task = createWakeTask({
      scheduleType: 'event',
      wakeOnSessions: JSON.stringify({
        targets: [{ agentSlug: 'agent-b', sessionId: 'sess-b', outcome: 'completed' }],
      }),
    })
    mockGetScheduledTask.mockResolvedValue(task)

    expect((await deliverSessionWake(task, 'scheduled')).outcome).toBe('delivered')
    expect(mockCancelAwaitingInput).not.toHaveBeenCalled()
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
  })

  it('Wake now still sends when the row is not due', async () => {
    const task = createWakeTask({
      scheduleType: 'event',
      nextExecutionAt: null,
      wakeOnSessions: JSON.stringify({
        targets: [{ agentSlug: 'agent-b', sessionId: 'sess-b' }],
      }),
    })
    mockGetScheduledTask.mockResolvedValue(task)

    expect((await deliverSessionWake(task, 'manual')).outcome).toBe('delivered')
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(mockCancelAwaitingInput).toHaveBeenCalled()
  })

  it('still cancels a question on a timed wake and on Wake now', async () => {
    mockIsSessionAwaitingInput.mockReturnValue(true)
    const timed = createWakeTask({
      wakeOnSessions: JSON.stringify({
        targets: [{ agentSlug: 'agent-b', sessionId: 'sess-b', outcome: 'completed' }],
      }),
    })
    mockGetScheduledTask.mockResolvedValue(timed)
    expect((await deliverSessionWake(timed, 'scheduled')).outcome).toBe('delivered')
    expect(mockCancelAwaitingInput).toHaveBeenCalled()

    mockCancelAwaitingInput.mockClear()
    mockSendMessage.mockClear()
    const event = createWakeTask({
      scheduleType: 'event',
      wakeOnSessions: JSON.stringify({
        targets: [{ agentSlug: 'agent-b', sessionId: 'sess-b', outcome: 'completed' }],
      }),
    })
    mockGetScheduledTask.mockResolvedValue(event)
    expect((await deliverSessionWake(event, 'manual')).outcome).toBe('delivered')
    expect(mockCancelAwaitingInput).toHaveBeenCalled()
  })
})
