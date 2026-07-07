import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'

// Per-task overlap guard: a recurring task must not spawn a second concurrent
// session while its previous run is still actively progressing. See the guard in
// executeTaskInner. Occupied predicate:
//   isSessionActive(lastSessionId) && !isSessionAwaitingInput(lastSessionId)

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

vi.mock('@shared/lib/services/session-service', () => ({
  getSessionForScheduledExecution: (...args: unknown[]) =>
    mockGetSessionForScheduledExecution(...args),
  registerSession: (...args: unknown[]) => mockRegisterSession(...args),
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

const mockCaptureException = vi.fn()

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

import { taskScheduler } from './task-scheduler'

const nextExecutionAt = new Date('2026-06-26T17:00:00.000Z')
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
    nextExecutionAt,
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
    createdAt: new Date('2026-06-26T16:00:00.000Z'),
    cancelledAt: null,
    pausedAt: null,
    ...overrides,
  }
}

describe('TaskScheduler per-task overlap guard', () => {
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
    mockGetSecretEnvVars.mockResolvedValue([])
    mockAgentExists.mockResolvedValue(true)
    mockGetSessionForScheduledExecution.mockResolvedValue(null)
    mockMarkTaskExecuted.mockResolvedValue(undefined)
    mockMarkTaskFailed.mockResolvedValue(undefined)
    mockUpdateNextExecution.mockResolvedValue(undefined)
    mockRecordTaskSkip.mockResolvedValue(undefined)
    mockRescheduleAfterFailure.mockResolvedValue(undefined)
    mockGetNextCronTime.mockReturnValue(reanchoredAt)
    // Default: previous run is idle (not occupied) so tasks fire normally.
    mockIsSessionActive.mockReturnValue(false)
    mockIsSessionAwaitingInput.mockReturnValue(false)
  })

  afterEach(() => {
    taskScheduler.stop()
    consoleErrorSpy.mockRestore()
    consoleLogSpy.mockRestore()
  })

  it('holds a recurring task whose previous run is still actively running (no second session)', async () => {
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    mockIsSessionActive.mockReturnValue(true)
    mockIsSessionAwaitingInput.mockReturnValue(false)

    await taskScheduler.triggerExecution()

    // Held: no new container/session spun up.
    expect(mockEnsureRunning).not.toHaveBeenCalled()
    expect(mockCreateSession).not.toHaveBeenCalled()
    // nextExecutionAt is NOT advanced — the task stays due.
    expect(mockUpdateNextExecution).not.toHaveBeenCalled()
    // The occupied predicate was evaluated against the previous run's session.
    expect(mockIsSessionActive).toHaveBeenCalledWith('prev-session-1')
    // The hold is recorded for skip observability.
    expect(mockRecordTaskSkip).toHaveBeenCalledTimes(1)
    expect(mockRecordTaskSkip).toHaveBeenCalledWith('task-1')
  })

  it('fires a recurring task whose previous run is parked on user input', async () => {
    // A parked run has nobody to answer an offline scheduled question, so it must
    // not wedge the task: active=true but awaitingInput=true => NOT occupied.
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    mockIsSessionActive.mockReturnValue(true)
    mockIsSessionAwaitingInput.mockReturnValue(true)

    await taskScheduler.triggerExecution()

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mockRecordTaskSkip).not.toHaveBeenCalled()
    // Fires and re-anchors forward.
    expect(mockUpdateNextExecution).toHaveBeenCalledWith('task-1', reanchoredAt, 'new-session-1')
  })

  it('holds a recurring task whose previous run has a backgrounded task still executing', async () => {
    // A run with a run_in_background Bash/workflow stays active=true and
    // awaitingInput=false (it emits session_waiting_background), so it counts as
    // occupied exactly like a foreground-busy run.
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    mockIsSessionActive.mockReturnValue(true)
    mockIsSessionAwaitingInput.mockReturnValue(false)

    await taskScheduler.triggerExecution()

    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockUpdateNextExecution).not.toHaveBeenCalled()
    expect(mockRecordTaskSkip).toHaveBeenCalledTimes(1)
  })

  it('fires a recurring task whose previous run has gone idle', async () => {
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    mockIsSessionActive.mockReturnValue(false)

    await taskScheduler.triggerExecution()

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mockRecordTaskSkip).not.toHaveBeenCalled()
    expect(mockUpdateNextExecution).toHaveBeenCalledWith('task-1', reanchoredAt, 'new-session-1')
  })

  it('holds then fires once and re-anchors when the slot frees on a later poll', async () => {
    const task = createRecurringTask()
    // The task remains due across both polls because a held cycle does not advance
    // nextExecutionAt.
    mockGetDueTasks.mockResolvedValue([task])
    // Poll 1: previous run busy -> hold. Poll 2: previous run idle -> fire.
    mockIsSessionActive.mockReturnValueOnce(true).mockReturnValue(false)

    await taskScheduler.triggerExecution()
    await taskScheduler.triggerExecution()

    // Exactly one session spawned across the two polls — capped at 1 concurrent.
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mockRecordTaskSkip).toHaveBeenCalledTimes(1)
    // Re-anchors forward via getNextCronTime(now) on the successful fire.
    expect(mockUpdateNextExecution).toHaveBeenCalledTimes(1)
    expect(mockUpdateNextExecution).toHaveBeenCalledWith('task-1', reanchoredAt, 'new-session-1')
  })

  it('still holds when the skip bookkeeping write fails — the schedule must not advance', async () => {
    // Regression: recordTaskSkip rejecting must NOT escape executeTaskInner as
    // an execution failure. A hold is not a failure — the failure path advances
    // the schedule, abandoning the pending fire a held task is entitled to. The
    // skip counter is best-effort observability; the hold must not depend on it.
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    mockIsSessionActive.mockReturnValue(true)
    mockIsSessionAwaitingInput.mockReturnValue(false)
    mockRecordTaskSkip.mockRejectedValue(new Error('SQLite write failed'))

    await taskScheduler.triggerExecution()

    // Still held: no second session.
    expect(mockCreateSession).not.toHaveBeenCalled()
    // THE regression assertions: neither the fire record nor the failure
    // reschedule may run — the task must stay due and untouched.
    expect(mockUpdateNextExecution).not.toHaveBeenCalled()
    expect(mockRescheduleAfterFailure).not.toHaveBeenCalled()
    expect(mockMarkTaskFailed).not.toHaveBeenCalled()
    // The bookkeeping failure is still reported, just not escalated.
    expect(mockCaptureException).toHaveBeenCalled()
  })

  it('a transient pre-guard failure reschedules without touching the guard state', async () => {
    // A throw before the guard (the reconcile lookup does disk I/O every held
    // poll) must not blank lastSessionId or wipe the hold streak — that would
    // disarm the guard and allow the overlap it exists to prevent. The failure
    // path uses rescheduleAfterFailure (advance-only), never the fire record.
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    mockGetSessionForScheduledExecution.mockRejectedValue(new Error('transient FS error'))

    await taskScheduler.triggerExecution()

    expect(mockCreateSession).not.toHaveBeenCalled()
    // Advance-only reschedule; the fire record (which rewrites lastSessionId
    // and resets the streak) must not run.
    expect(mockRescheduleAfterFailure).toHaveBeenCalledTimes(1)
    expect(mockRescheduleAfterFailure).toHaveBeenCalledWith('task-1', reanchoredAt)
    expect(mockUpdateNextExecution).not.toHaveBeenCalled()
    expect(mockCaptureException).toHaveBeenCalled()
  })

  it('records the real session when the fire fails after session creation', async () => {
    // createSession succeeded — the prompt is already executing in the container.
    // A subsequent registration failure must still record that session as the
    // fire's session so the overlap guard arms against the orphan, rather than
    // going through the failure path which records no session at all.
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    mockIsSessionActive.mockReturnValue(false)
    mockRegisterSession.mockRejectedValue(new Error('metadata write failed'))

    await taskScheduler.triggerExecution()

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    // The orphan is recorded as this fire's session (real id, not '').
    expect(mockUpdateNextExecution).toHaveBeenCalledWith('task-1', reanchoredAt, 'new-session-1')
    // The error still surfaces through the failure accounting.
    expect(mockCaptureException).toHaveBeenCalled()
  })

  it('fires normally on a later poll after a failed skip write, once the slot frees', async () => {
    mockGetDueTasks.mockResolvedValue([createRecurringTask()])
    // Poll 1: occupied + skip write fails. Poll 2: slot freed.
    mockIsSessionActive.mockReturnValueOnce(true).mockReturnValue(false)
    mockRecordTaskSkip.mockRejectedValueOnce(new Error('SQLite write failed'))

    await taskScheduler.triggerExecution()
    await taskScheduler.triggerExecution()

    // The guard stayed armed through the failed write: exactly one fire.
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mockUpdateNextExecution).toHaveBeenCalledTimes(1)
    expect(mockUpdateNextExecution).toHaveBeenCalledWith('task-1', reanchoredAt, 'new-session-1')
  })

  it('does not apply the overlap guard to a recurring task with no prior session', async () => {
    mockGetDueTasks.mockResolvedValue([createRecurringTask({ lastSessionId: null })])
    // Even if some stale streaming state is somehow active, a null lastSessionId
    // means there is nothing to guard against — the task fires.
    mockIsSessionActive.mockReturnValue(true)

    await taskScheduler.triggerExecution()

    expect(mockIsSessionActive).not.toHaveBeenCalled()
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mockRecordTaskSkip).not.toHaveBeenCalled()
  })

  it('does not apply the overlap guard to one-time (at) tasks', async () => {
    // Crons only: a one-time task fires once and is marked executed, so it can
    // never overlap. Guard must be skipped even if a prior session is active.
    mockGetDueTasks.mockResolvedValue([
      createRecurringTask({
        scheduleType: 'at',
        isRecurring: false,
        lastSessionId: 'prev-session-1',
      }),
    ])
    mockIsSessionActive.mockReturnValue(true)
    mockIsSessionAwaitingInput.mockReturnValue(false)

    await taskScheduler.triggerExecution()

    expect(mockIsSessionActive).not.toHaveBeenCalled()
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    expect(mockRecordTaskSkip).not.toHaveBeenCalled()
    expect(mockMarkTaskExecuted).toHaveBeenCalledWith('task-1', 'new-session-1')
  })
})
