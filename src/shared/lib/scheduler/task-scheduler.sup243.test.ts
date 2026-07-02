import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'

const mockGetDueTasks = vi.fn()
const mockMarkTaskExecuted = vi.fn()
const mockMarkTaskFailed = vi.fn()
const mockUpdateNextExecution = vi.fn()
const mockRecordTaskSkip = vi.fn()
const mockRescheduleAfterFailure = vi.fn()

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getDueTasks: (...args: unknown[]) => mockGetDueTasks(...args),
  markTaskExecuted: (...args: unknown[]) => mockMarkTaskExecuted(...args),
  markTaskFailed: (...args: unknown[]) => mockMarkTaskFailed(...args),
  updateNextExecution: (...args: unknown[]) => mockUpdateNextExecution(...args),
  recordTaskSkip: (...args: unknown[]) => mockRecordTaskSkip(...args),
  rescheduleAfterFailure: (...args: unknown[]) => mockRescheduleAfterFailure(...args),
}))

const mockCreateSession = vi.fn()
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

const mockSubscribeToSession = vi.fn()
const mockMarkSessionActive = vi.fn()

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    subscribeToSession: (...args: unknown[]) => mockSubscribeToSession(...args),
    markSessionActive: (...args: unknown[]) => mockMarkSessionActive(...args),
  },
}))

const mockTriggerScheduledSessionStarted = vi.fn()

vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: {
    triggerScheduledSessionStarted: (...args: unknown[]) =>
      mockTriggerScheduledSessionStarted(...args),
  },
}))

const mockGetSessionForScheduledExecution = vi.fn()
const mockRegisterSession = vi.fn()
const mockUpdateSessionMetadata = vi.fn()

vi.mock('@shared/lib/services/session-service', () => ({
  getSessionForScheduledExecution: (...args: unknown[]) =>
    mockGetSessionForScheduledExecution(...args),
  registerSession: (...args: unknown[]) => mockRegisterSession(...args),
  updateSessionMetadata: (...args: unknown[]) => mockUpdateSessionMetadata(...args),
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

const mockRunWithOptionalUser = vi.fn(
  (_userId: string | null | undefined, fn: () => unknown) => fn(),
)

vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: (userId: string | null | undefined, fn: () => unknown) =>
    mockRunWithOptionalUser(userId, fn),
}))

const mockCaptureException = vi.fn()

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

import { taskScheduler } from './task-scheduler'

const scheduledExecutionAt = new Date('2026-06-26T17:00:00.000Z')
const nextExecutionAt = new Date('2026-06-26T17:05:00.000Z')

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    agentSlug: 'agent-one',
    scheduleType: 'at',
    scheduleExpression: 'at 2026-06-26 10:00',
    prompt: 'Run the scheduled report',
    name: 'Daily report',
    status: 'pending',
    nextExecutionAt: scheduledExecutionAt,
    lastExecutedAt: null,
    isRecurring: false,
    executionCount: 0,
    consecutiveSkips: 0,
    lastSkippedAt: null,
    lastSessionId: null,
    createdBySessionId: null,
    createdByUserId: 'user-1',
    timezone: 'America/Los_Angeles',
    model: null,
    effort: null,
    createdAt: new Date('2026-06-26T16:00:00.000Z'),
    cancelledAt: null,
    pausedAt: null,
    ...overrides,
  }
}

function existingScheduledSession(sessionId = 'container-session-1') {
  return {
    id: sessionId,
    agentSlug: 'agent-one',
    name: 'Daily report',
    createdAt: scheduledExecutionAt,
    lastActivityAt: scheduledExecutionAt,
    messageCount: 0,
  }
}

describe('TaskScheduler duplicate execution guard (SUP-243)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    taskScheduler.stop()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.clearAllMocks()
    mockGetDueTasks.mockResolvedValue([])
    mockEnsureRunning.mockResolvedValue({ createSession: mockCreateSession })
    mockCreateSession.mockResolvedValue({ id: 'container-session-1' })
    mockSubscribeToSession.mockResolvedValue(undefined)
    mockTriggerScheduledSessionStarted.mockResolvedValue(undefined)
    mockRegisterSession.mockResolvedValue(undefined)
    mockUpdateSessionMetadata.mockResolvedValue(undefined)
    mockGetSecretEnvVars.mockResolvedValue([])
    mockAgentExists.mockResolvedValue(true)
    mockGetSessionForScheduledExecution.mockResolvedValue(null)
    mockMarkTaskExecuted.mockResolvedValue(undefined)
    mockMarkTaskFailed.mockResolvedValue(undefined)
    mockUpdateNextExecution.mockResolvedValue(undefined)
    mockRecordTaskSkip.mockResolvedValue(undefined)
    mockRescheduleAfterFailure.mockResolvedValue(undefined)
    mockGetNextCronTime.mockReturnValue(nextExecutionAt)
  })

  afterEach(() => {
    taskScheduler.stop()
    consoleErrorSpy.mockRestore()
  })

  it('reconciles a retried one-time task with the existing scheduled session instead of creating a duplicate', async () => {
    const task = createTask()
    mockGetDueTasks.mockResolvedValue([task])
    mockGetSessionForScheduledExecution
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingScheduledSession())
    mockMarkTaskExecuted
      .mockRejectedValueOnce(new Error('lost durable mark'))
      .mockResolvedValueOnce(undefined)
    mockMarkTaskFailed.mockRejectedValue(new Error('same SQLite outage'))

    await taskScheduler.triggerExecution()
    await taskScheduler.triggerExecution()

    expect(mockGetSessionForScheduledExecution).toHaveBeenNthCalledWith(
      1,
      'agent-one',
      'task-1',
      scheduledExecutionAt,
    )
    expect(mockGetSessionForScheduledExecution).toHaveBeenNthCalledWith(
      2,
      'agent-one',
      'task-1',
      scheduledExecutionAt,
    )
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mockEnsureRunning).toHaveBeenCalledTimes(1)
    expect(mockRegisterSession).toHaveBeenCalledWith(
      'agent-one',
      'container-session-1',
      'Daily report',
      expect.objectContaining({
        isScheduledExecution: true,
        scheduledTaskId: 'task-1',
        scheduledTaskName: 'Daily report',
        scheduledExecutionAt: scheduledExecutionAt.toISOString(),
      }),
    )
    expect(mockUpdateSessionMetadata).not.toHaveBeenCalled()
    expect(mockMarkTaskExecuted).toHaveBeenNthCalledWith(1, 'task-1', 'container-session-1')
    expect(mockMarkTaskExecuted).toHaveBeenNthCalledWith(2, 'task-1', 'container-session-1')
  })

  it('reconciles a retried recurring task with the existing scheduled session and advances the schedule', async () => {
    const task = createTask({
      scheduleType: 'cron',
      scheduleExpression: '*/5 * * * *',
      isRecurring: true,
    })
    mockGetDueTasks.mockResolvedValue([task])
    mockGetSessionForScheduledExecution
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingScheduledSession())
    mockUpdateNextExecution
      .mockRejectedValueOnce(new Error('lost durable advance'))
      .mockResolvedValueOnce(undefined)
    mockRescheduleAfterFailure.mockRejectedValue(new Error('same SQLite outage'))
    mockMarkTaskFailed.mockRejectedValue(new Error('same SQLite outage'))

    await taskScheduler.triggerExecution()
    await taskScheduler.triggerExecution()

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    // Fire attempt: the durable advance carries the real session id.
    expect(mockUpdateNextExecution).toHaveBeenNthCalledWith(
      1,
      'task-1',
      nextExecutionAt,
      'container-session-1',
    )
    // Failure path: advance-only reschedule — never a fire record with a
    // blank session id (that would disarm the overlap guard).
    expect(mockRescheduleAfterFailure).toHaveBeenCalledWith('task-1', nextExecutionAt)
    // Retry poll reconciles with the existing session and records it.
    expect(mockUpdateNextExecution).toHaveBeenNthCalledWith(
      2,
      'task-1',
      nextExecutionAt,
      'container-session-1',
    )
  })
})
