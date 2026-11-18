import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// SUP-224 — Task scheduler startup must not wedge when its first read of the
// schedules fails.
//
// start() does NOT reject on a transient failure there (e.g. a SQLite hiccup):
// it reports to Sentry and reads them again a minute later, so isActive() stays
// true and the scheduler self-heals.
//
// Only the scheduled-task-service boundary and the error-reporting sink need
// mocking; with no schedules to fire, executeTask is never reached, so the heavy
// collaborators (containerHost, the agents' live sessions, …) aren't exercised.
// ============================================================================

const mockListPendingScheduledTaskIds = vi.fn()
const mockSyncScheduleWakeup = vi.fn().mockResolvedValue(undefined)

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getDueTasks: vi.fn(() => Promise.resolve([])),
  getScheduledTask: vi.fn(() => Promise.resolve(null)),
  listPendingScheduledTaskIds: (...args: unknown[]) => mockListPendingScheduledTaskIds(...args),
  syncScheduleWakeup: (...args: unknown[]) => mockSyncScheduleWakeup(...args),
}))

const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

// Import after mocks
import { taskScheduler } from './task-scheduler'
import { registerTasks } from '@shared/lib/background-work/testing/register-tasks'

const RECHECK_MS = 60000

describe('TaskScheduler startup resilience (SUP-224)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerTasks(taskScheduler)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    // Reset the singleton so a lingering retry / isRunning never leaks.
    taskScheduler.stop()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('does not wedge when the first read of the schedules fails — stays active and self-heals a minute later', async () => {
    vi.useFakeTimers()
    mockListPendingScheduledTaskIds
      .mockRejectedValueOnce(new Error('transient SQLite error'))
      .mockResolvedValue(['schedule-1'])

    // start() must NOT reject: the failure is non-fatal.
    await expect(taskScheduler.start()).resolves.toBeUndefined()

    // The bug was isActive() going false (or wedged true with nothing left to run it).
    expect(taskScheduler.isActive()).toBe(true)

    // The failure was reported to Sentry, tagged as the initial scan.
    expect(mockCaptureException).toHaveBeenCalledTimes(1)
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      tags: { component: 'task-scheduler', phase: 'initial-scan' },
    })
    expect(mockSyncScheduleWakeup).not.toHaveBeenCalled()

    // The retry is real: a minute on, the schedules get their wakeups.
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(mockSyncScheduleWakeup).toHaveBeenCalledExactlyOnceWith('schedule-1')
    expect(mockCaptureException).toHaveBeenCalledTimes(1)
  })

  it('keeps trying for as long as the read keeps failing', async () => {
    vi.useFakeTimers()
    mockListPendingScheduledTaskIds.mockRejectedValue(new Error('still locked'))
    await taskScheduler.start()
    await vi.advanceTimersByTimeAsync(RECHECK_MS * 3)
    expect(mockListPendingScheduledTaskIds).toHaveBeenCalledTimes(4)
    expect(taskScheduler.isActive()).toBe(true)

    mockListPendingScheduledTaskIds.mockReset().mockResolvedValue([])
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(mockListPendingScheduledTaskIds).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RECHECK_MS * 3)
    expect(mockListPendingScheduledTaskIds).toHaveBeenCalledTimes(1)
  })

  it('stops trying once stopped', async () => {
    vi.useFakeTimers()
    mockListPendingScheduledTaskIds.mockRejectedValue(new Error('still locked'))
    await taskScheduler.start()
    taskScheduler.stop()
    await vi.advanceTimersByTimeAsync(RECHECK_MS * 3)
    expect(mockListPendingScheduledTaskIds).toHaveBeenCalledTimes(1)
  })

  it('sets the wakeups and stays active on a clean startup', async () => {
    vi.useFakeTimers()
    mockListPendingScheduledTaskIds.mockResolvedValue(['a', 'b'])

    await taskScheduler.start()
    expect(taskScheduler.isActive()).toBe(true)
    expect(mockSyncScheduleWakeup.mock.calls).toEqual([['a'], ['b']])

    // A redundant start() while active is a no-op and must not reset state.
    await taskScheduler.start()
    expect(mockListPendingScheduledTaskIds).toHaveBeenCalledTimes(1)
    expect(taskScheduler.isActive()).toBe(true)
    expect(mockCaptureException).not.toHaveBeenCalled() // the clean path never reports

    taskScheduler.stop()
    expect(taskScheduler.isActive()).toBe(false)
  })
})
