import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'

// Overlap guard: a recurring task must not start a second session while its
// previous run is still busy (active and not parked on user input).

const mockGetDueTasks = vi.fn()
const mockMarkTaskExecuted = vi.fn()
const mockMarkTaskFailed = vi.fn()
const mockUpdateNextExecution = vi.fn()
const mockRescheduleAfterFailure = vi.fn()
const mockRecordTaskSkip = vi.fn()

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getDueTasks: (...args: unknown[]) => mockGetDueTasks(...args),
  getScheduledTask: vi.fn(() => Promise.resolve(null)),
  markTaskExecuted: (...args: unknown[]) => mockMarkTaskExecuted(...args),
  markTaskFailed: (...args: unknown[]) => mockMarkTaskFailed(...args),
  updateNextExecution: (...args: unknown[]) => mockUpdateNextExecution(...args),
  rescheduleAfterFailure: (...args: unknown[]) => mockRescheduleAfterFailure(...args),
  recordTaskSkip: (...args: unknown[]) => mockRecordTaskSkip(...args),
}))

const mockCreateSession = vi.fn()
const mockEnsureRunning = vi.fn()

// The actor reaches the container client through getClient after start();
// hand back whatever ensureRunning last resolved to.
let mockClient: unknown
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      ensureRunning: async (...args: unknown[]) => {
        mockClient = await mockEnsureRunning(...args)
        return mockClient
      },
      getClient: () => mockClient,
    }),
  }
})

vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveModels: () => ({
    agentModel: 'claude-sonnet-4-20250514',
    browserModel: 'claude-sonnet-4-20250514',
    dashboardBuilderModel: 'claude-sonnet-4-20250514',
  }),
}))

const mockSubscribeToSession = vi.fn()
const mockMarkSessionActive = vi.fn()
const mockIsSessionActive = vi.fn()
const mockIsSessionAwaitingInput = vi.fn()

vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    subscribeToSession: (...args: unknown[]) => mockSubscribeToSession(...args),
    markSessionActive: (...args: unknown[]) => mockMarkSessionActive(...args),
    isSessionActive: (...args: unknown[]) => mockIsSessionActive(...args),
    isSessionAwaitingInput: (...args: unknown[]) => mockIsSessionAwaitingInput(...args),
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
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
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
const reanchoredAt = new Date('2026-06-26T17:05:00.000Z')

function createRecurringTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    agentSlug: 'agent-one',
    scheduleType: 'cron',
    scheduleExpression: '*/5 * * * *',
    prompt: 'Run the recurring report',
    name: 'Recurring report',
    status: 'pending',
    nextExecutionAt: scheduledExecutionAt,
    lastExecutedAt: null,
    isRecurring: true,
    executionCount: 3,
    consecutiveSkips: 0,
    lastSkippedAt: null,
    lastSessionId: 'prev-session-1',
    createdBySessionId: null,
    createdByUserId: 'user-1',
    timezone: null,
    model: null,
    effort: null,
    speed: null,
    resumeSessionId: null,
    createdAt: new Date('2026-06-26T16:00:00.000Z'),
    cancelledAt: null,
    pausedAt: null,
    ...overrides,
  }
}

describe('TaskScheduler overlap guard', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    taskScheduler.stop()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    vi.clearAllMocks()
    mockGetDueTasks.mockResolvedValue([])
    mockEnsureRunning.mockResolvedValue({ createSession: mockCreateSession })
    mockCreateSession.mockResolvedValue({ id: 'new-session-1' })
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
    mockRescheduleAfterFailure.mockResolvedValue(undefined)
    mockRecordTaskSkip.mockResolvedValue(undefined)
    mockGetNextCronTime.mockReturnValue(reanchoredAt)
    // Default: the previous run has settled, so tasks fire.
    mockIsSessionActive.mockReturnValue(false)
    mockIsSessionAwaitingInput.mockReturnValue(false)
  })

  afterEach(() => {
    taskScheduler.stop()
    consoleErrorSpy.mockRestore()
    consoleLogSpy.mockRestore()
  })

  it('holds a recurring task whose previous run is still busy', async () => {
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    mockIsSessionActive.mockReturnValue(true)

    await taskScheduler.triggerExecution()

    expect(mockIsSessionActive).toHaveBeenCalledWith('agent-one', 'prev-session-1')
    expect(mockEnsureRunning).not.toHaveBeenCalled()
    expect(mockCreateSession).not.toHaveBeenCalled()
    // The task stays due: nothing advances nextExecutionAt.
    expect(mockUpdateNextExecution).not.toHaveBeenCalled()
    expect(mockRescheduleAfterFailure).not.toHaveBeenCalled()
    expect(mockRecordTaskSkip).toHaveBeenCalledExactlyOnceWith('task-1')
  })

  it('fires a recurring task whose previous run is parked on user input', async () => {
    // Nobody is there to answer an unattended run, so a parked run frees the slot.
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    mockIsSessionActive.mockReturnValue(true)
    mockIsSessionAwaitingInput.mockReturnValue(true)

    await taskScheduler.triggerExecution()

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mockRecordTaskSkip).not.toHaveBeenCalled()
    expect(mockUpdateNextExecution).toHaveBeenCalledWith('task-1', reanchoredAt, 'new-session-1')
  })

  it('fires a recurring task whose previous run has settled', async () => {
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])

    await taskScheduler.triggerExecution()

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mockRecordTaskSkip).not.toHaveBeenCalled()
    expect(mockUpdateNextExecution).toHaveBeenCalledWith('task-1', reanchoredAt, 'new-session-1')
  })

  it('fires once and re-anchors on the first poll after the previous run settles', async () => {
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    mockIsSessionActive.mockReturnValueOnce(true).mockReturnValue(false)

    await taskScheduler.triggerExecution()
    await taskScheduler.triggerExecution()

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mockRecordTaskSkip).toHaveBeenCalledTimes(1)
    expect(mockUpdateNextExecution).toHaveBeenCalledExactlyOnceWith('task-1', reanchoredAt, 'new-session-1')
  })

  it('still holds when the skip write fails', async () => {
    // A hold is not a failure. If the failed write reached the failure path,
    // the schedule would advance and the held fire would be dropped.
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    mockIsSessionActive.mockReturnValue(true)
    mockRecordTaskSkip.mockRejectedValue(new Error('SQLite write failed'))

    await taskScheduler.triggerExecution()

    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockUpdateNextExecution).not.toHaveBeenCalled()
    expect(mockRescheduleAfterFailure).not.toHaveBeenCalled()
    expect(mockMarkTaskFailed).not.toHaveBeenCalled()
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ phase: 'record-skip' }) }),
    )
  })

  it('keeps pointing at the previous run when a fire attempt fails', async () => {
    // Recording the failure as a fire with a blank session id would disarm
    // the guard for the next poll.
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    mockGetSessionForScheduledExecution.mockRejectedValue(new Error('transient FS error'))

    await taskScheduler.triggerExecution()

    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockRescheduleAfterFailure).toHaveBeenCalledExactlyOnceWith('task-1', reanchoredAt)
    expect(mockUpdateNextExecution).not.toHaveBeenCalled()
  })

  it('does not check a recurring task that has never run', async () => {
    mockGetDueTasks.mockResolvedValue([createRecurringTask({ lastSessionId: null })])
    mockIsSessionActive.mockReturnValue(true)

    await taskScheduler.triggerExecution()

    expect(mockIsSessionActive).not.toHaveBeenCalled()
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
  })

  it('does not apply to one-time tasks', async () => {
    mockGetDueTasks.mockResolvedValue([
      createRecurringTask({ scheduleType: 'at', isRecurring: false }),
    ])
    mockIsSessionActive.mockReturnValue(true)

    await taskScheduler.triggerExecution()

    expect(mockIsSessionActive).not.toHaveBeenCalled()
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mockMarkTaskExecuted).toHaveBeenCalledWith('task-1', 'new-session-1')
  })
})
