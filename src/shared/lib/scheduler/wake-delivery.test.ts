import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'

const mockGetScheduledTask = vi.fn()
const mockMarkTaskExecuted = vi.fn()

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getScheduledTask: (...args: unknown[]) => mockGetScheduledTask(...args),
  markTaskExecuted: (...args: unknown[]) => mockMarkTaskExecuted(...args),
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

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    subscribeToSession: (...args: unknown[]) => mockSubscribeToSession(...args),
    markSessionActive: (...args: unknown[]) => mockMarkSessionActive(...args),
    markSessionIdle: (...args: unknown[]) => mockMarkSessionIdle(...args),
    isSubscribed: (...args: unknown[]) => mockIsSubscribed(...args),
    cancelAwaitingInput: (...args: unknown[]) => mockCancelAwaitingInput(...args),
    broadcastGlobal: (...args: unknown[]) => mockBroadcastGlobal(...args),
    broadcastSessionUpdate: (...args: unknown[]) => mockBroadcastSessionUpdate(...args),
  },
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
})
