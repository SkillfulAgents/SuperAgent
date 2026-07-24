import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'

const mockGetDueTasks = vi.fn()
const mockGetScheduledTask = vi.fn()
const mockMarkTaskExecuted = vi.fn()
const mockMarkTaskFailed = vi.fn()
const mockUpdateNextExecution = vi.fn()

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getDueTasks: (...args: unknown[]) => mockGetDueTasks(...args),
  getScheduledTask: (...args: unknown[]) => mockGetScheduledTask(...args),
  markTaskExecuted: (...args: unknown[]) => mockMarkTaskExecuted(...args),
  markTaskFailed: (...args: unknown[]) => mockMarkTaskFailed(...args),
  updateNextExecution: (...args: unknown[]) => mockUpdateNextExecution(...args),
}))

const mockCreateSession = vi.fn()
const mockSendMessage = vi.fn()
const mockEnsureRunning = vi.fn()

vi.mock('@shared/lib/container/container-manager', () => ({
  containerManager: {
    ensureRunning: (...args: unknown[]) => mockEnsureRunning(...args),
  },
}))

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveModels: () => ({
    agentModel: 'claude-sonnet-4-20250514',
    browserModel: 'claude-sonnet-4-20250514',
    dashboardBuilderModel: 'claude-sonnet-4-20250514',
  }),
}))

vi.mock('@shared/lib/services/agent-preferences-service', () => ({
  readAgentPreferences: () => Promise.resolve({}),
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

const mockTriggerScheduledSessionStarted = vi.fn()
const mockTriggerScheduledSessionResumed = vi.fn()

vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerScheduledSessionStarted: (...args: unknown[]) =>
      mockTriggerScheduledSessionStarted(...args),
    triggerScheduledSessionResumed: (...args: unknown[]) =>
      mockTriggerScheduledSessionResumed(...args),
  },
}))

const mockGetSessionForScheduledExecution = vi.fn()
const mockRegisterSession = vi.fn()
const mockUpdateSessionMetadata = vi.fn()
const mockGetSessionMetadata = vi.fn()

vi.mock('@shared/lib/services/session-service', () => ({
  getSessionForScheduledExecution: (...args: unknown[]) =>
    mockGetSessionForScheduledExecution(...args),
  registerSession: (...args: unknown[]) => mockRegisterSession(...args),
  updateSessionMetadata: (...args: unknown[]) => mockUpdateSessionMetadata(...args),
  getSessionMetadata: (...args: unknown[]) => mockGetSessionMetadata(...args),
}))

const mockGetSecretEnvVars = vi.fn()

vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: (...args: unknown[]) => mockGetSecretEnvVars(...args),
}))

const mockAgentExists = vi.fn()

vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: (...args: unknown[]) => mockAgentExists(...args),
}))

const mockGetNextCronTime = vi.fn()

vi.mock('@shared/lib/services/schedule-parser', () => ({
  getNextCronTime: (...args: unknown[]) => mockGetNextCronTime(...args),
}))

vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: (_userId: string | null | undefined, fn: () => unknown) => fn(),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

import { taskScheduler } from './task-scheduler'

const wakeExecutionAt = new Date('2026-06-26T17:00:00.000Z')

function createWakeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'wake-task-1',
    agentSlug: 'agent-one',
    scheduleType: 'at',
    scheduleExpression: 'at tomorrow 9am',
    prompt: 'Check whether Dana replied to the intro email',
    name: null,
    status: 'pending',
    nextExecutionAt: wakeExecutionAt,
    lastExecutedAt: null,
    isRecurring: false,
    executionCount: 0,
    lastSessionId: null,
    createdBySessionId: 'sleeping-session-1',
    createdByUserId: 'user-1',
    timezone: 'America/Los_Angeles',
    model: null,
    effort: null,
    speed: null,
    resumeSessionId: 'sleeping-session-1',
    executionMode: 'session',
    classifierConfig: null,
    createdAt: new Date('2026-06-25T16:00:00.000Z'),
    cancelledAt: null,
    pausedAt: null,
    ...overrides,
  }
}

describe('TaskScheduler session wake (resume) branch', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    taskScheduler.stop()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.clearAllMocks()
    vi.useFakeTimers()
    // 5 minutes after the wake was due — well within the retry window
    vi.setSystemTime(new Date('2026-06-26T17:05:00.000Z'))

    mockGetDueTasks.mockResolvedValue([])
    // The delivery path re-reads the task under its claim; serve the same task
    // the due-batch returned so each test primes one place.
    mockGetScheduledTask.mockImplementation(
      async (id: string) => ((await mockGetDueTasks()) as ScheduledTask[]).find((t) => t.id === id) ?? null
    )
    mockEnsureRunning.mockResolvedValue({
      createSession: mockCreateSession,
      sendMessage: mockSendMessage,
    })
    mockCreateSession.mockResolvedValue({ id: 'new-session-should-not-happen' })
    mockSendMessage.mockResolvedValue(undefined)
    mockSubscribeToSession.mockResolvedValue(undefined)
    mockIsSubscribed.mockReturnValue(false)
    mockCancelAwaitingInput.mockResolvedValue(undefined)
    mockTriggerScheduledSessionStarted.mockResolvedValue(undefined)
    mockTriggerScheduledSessionResumed.mockResolvedValue(undefined)
    mockRegisterSession.mockResolvedValue(undefined)
    mockUpdateSessionMetadata.mockResolvedValue(undefined)
    mockGetSessionMetadata.mockResolvedValue({
      name: 'Email follow-up',
      createdAt: '2026-06-20T10:00:00.000Z',
    })
    mockGetSecretEnvVars.mockResolvedValue([])
    mockAgentExists.mockResolvedValue(true)
    mockGetSessionForScheduledExecution.mockResolvedValue(null)
    mockMarkTaskExecuted.mockResolvedValue(undefined)
    mockMarkTaskFailed.mockResolvedValue(undefined)
  })

  afterEach(() => {
    taskScheduler.stop()
    vi.useRealTimers()
    consoleErrorSpy.mockRestore()
  })

  it('resumes the existing session instead of creating a new one', async () => {
    mockGetDueTasks.mockResolvedValue([createWakeTask()])

    await taskScheduler.triggerExecution()

    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockRegisterSession).not.toHaveBeenCalled()
    expect(mockEnsureRunning).toHaveBeenCalledWith('agent-one')

    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    const [sessionId, content, uuid, options] = mockSendMessage.mock.calls[0]
    expect(sessionId).toBe('sleeping-session-1')
    expect(content.startsWith('[SYSTEM] ')).toBe(true)
    expect(content).toContain('resuming as scheduled')
    expect(content).toContain('Check whether Dana replied to the intro email')
    expect(typeof uuid).toBe('string')
    expect(options).toEqual({ shouldQuery: true })

    expect(mockMarkSessionActive).toHaveBeenCalledWith('sleeping-session-1', 'agent-one')
    expect(mockMarkTaskExecuted).toHaveBeenCalledWith('wake-task-1', 'sleeping-session-1')
  })

  it('subscribes the session for SSE when not already subscribed', async () => {
    mockGetDueTasks.mockResolvedValue([createWakeTask()])
    mockIsSubscribed.mockReturnValue(false)

    await taskScheduler.triggerExecution()

    expect(mockSubscribeToSession).toHaveBeenCalledWith(
      'sleeping-session-1',
      expect.anything(),
      'sleeping-session-1',
      'agent-one'
    )
  })

  it('does not re-subscribe an already-subscribed session', async () => {
    mockGetDueTasks.mockResolvedValue([createWakeTask()])
    mockIsSubscribed.mockReturnValue(true)

    await taskScheduler.triggerExecution()

    expect(mockSubscribeToSession).not.toHaveBeenCalled()
    expect(mockSendMessage).toHaveBeenCalledTimes(1)
  })

  it('cancels a stale awaiting-input state before sending the wake message', async () => {
    mockGetDueTasks.mockResolvedValue([createWakeTask()])

    await taskScheduler.triggerExecution()

    expect(mockCancelAwaitingInput).toHaveBeenCalledWith('sleeping-session-1', 'agent-one')
    expect(mockCancelAwaitingInput.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendMessage.mock.invocationCallOrder[0]
    )
  })

  it('records the wake in session metadata after sending (duplicate-fire guard state)', async () => {
    mockGetDueTasks.mockResolvedValue([createWakeTask()])

    await taskScheduler.triggerExecution()

    expect(mockUpdateSessionMetadata).toHaveBeenCalledWith(
      'agent-one',
      'sleeping-session-1',
      {
        lastWake: {
          taskId: 'wake-task-1',
          executionAt: wakeExecutionAt.toISOString(),
        },
      }
    )
    // Side effect first, record after — mirrors the create path's crash-window semantics
    expect(mockSendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdateSessionMetadata.mock.invocationCallOrder[0]
    )
  })

  it('reconciles instead of double-sending when the wake already fired for this slot', async () => {
    mockGetDueTasks.mockResolvedValue([createWakeTask()])
    mockGetSessionMetadata.mockResolvedValue({
      name: 'Email follow-up',
      lastWake: {
        taskId: 'wake-task-1',
        executionAt: wakeExecutionAt.toISOString(),
      },
    })

    await taskScheduler.triggerExecution()

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockEnsureRunning).not.toHaveBeenCalled()
    expect(mockMarkTaskExecuted).toHaveBeenCalledWith('wake-task-1', 'sleeping-session-1')
  })

  it('still fires when the last recorded wake was for a previous sleep cycle', async () => {
    mockGetDueTasks.mockResolvedValue([createWakeTask()])
    mockGetSessionMetadata.mockResolvedValue({
      name: 'Email follow-up',
      lastWake: {
        taskId: 'an-earlier-wake-task',
        executionAt: '2026-06-25T17:00:00.000Z',
      },
    })

    await taskScheduler.triggerExecution()

    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(mockMarkTaskExecuted).toHaveBeenCalledWith('wake-task-1', 'sleeping-session-1')
  })

  it('fails the wake when the target session no longer exists', async () => {
    mockGetDueTasks.mockResolvedValue([createWakeTask()])
    mockGetSessionMetadata.mockResolvedValue(null)

    await taskScheduler.triggerExecution()

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockEnsureRunning).not.toHaveBeenCalled()
    expect(mockMarkTaskFailed).toHaveBeenCalledWith(
      'wake-task-1',
      expect.stringContaining('no longer exists')
    )
  })

  it('fails the wake when the agent no longer exists', async () => {
    mockGetDueTasks.mockResolvedValue([createWakeTask()])
    mockAgentExists.mockResolvedValue(false)

    await taskScheduler.triggerExecution()

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(mockMarkTaskFailed).toHaveBeenCalledWith(
      'wake-task-1',
      expect.stringContaining('Agent no longer exists')
    )
  })

  it('leaves a recently-due wake pending on transient failure so the poll retries it', async () => {
    mockGetDueTasks.mockResolvedValue([createWakeTask()])
    mockSendMessage.mockRejectedValue(new Error('container is restarting'))

    await taskScheduler.triggerExecution()

    expect(mockMarkTaskFailed).not.toHaveBeenCalled()
    expect(mockMarkTaskExecuted).not.toHaveBeenCalled()
    // The optimistic active flag is reverted — a failed delivery must not
    // leave the session looking busy until the retry lands.
    expect(mockMarkSessionIdle).toHaveBeenCalledWith('sleeping-session-1')
  })

  it('fails a wake once it has been retrying past the retry window', async () => {
    // 7 hours past due — beyond the 6h retry window
    vi.setSystemTime(new Date('2026-06-27T00:00:00.000Z'))
    mockGetDueTasks.mockResolvedValue([createWakeTask()])
    mockSendMessage.mockRejectedValue(new Error('container is restarting'))

    await taskScheduler.triggerExecution()

    expect(mockMarkTaskFailed).toHaveBeenCalledWith('wake-task-1', expect.any(String))
  })

  it('still fails a regular one-shot task immediately on error', async () => {
    const regularTask = createWakeTask({
      id: 'regular-task-1',
      resumeSessionId: null,
      createdBySessionId: null,
    })
    mockGetDueTasks.mockResolvedValue([regularTask])
    mockCreateSession.mockRejectedValue(new Error('boom'))

    await taskScheduler.triggerExecution()

    expect(mockMarkTaskFailed).toHaveBeenCalledWith('regular-task-1', expect.any(String))
  })

  it('triggers the resumed notification, not the started one', async () => {
    mockGetDueTasks.mockResolvedValue([createWakeTask()])

    await taskScheduler.triggerExecution()

    expect(mockTriggerScheduledSessionResumed).toHaveBeenCalledWith(
      'sleeping-session-1',
      'agent-one',
      'wake-task-1',
      expect.anything()
    )
    expect(mockTriggerScheduledSessionStarted).not.toHaveBeenCalled()
  })
})
