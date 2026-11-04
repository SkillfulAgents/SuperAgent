import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// SUP-224 — Task scheduler startup must not wedge when the initial overdue scan
// fails.
//
// start() only registers the scheduler's job; the job's first run is the
// catch-up scan, and every later run polls. A failed scan is reported to Sentry
// and retried on the next poll, so isActive() stays true and the scheduler
// self-heals.
//
// Only the scheduled-task-service boundary and the error-reporting sink need
// mocking; when scans return []/throw, executeTask is never reached, so the
// heavy collaborators (containerHost, the agents' live sessions, …) aren't
// exercised.
// ============================================================================

const mockGetDueTasks = vi.fn()
const mockMarkTaskExecuted = vi.fn().mockResolvedValue(undefined)
const mockMarkTaskFailed = vi.fn().mockResolvedValue(undefined)
const mockUpdateNextExecution = vi.fn().mockResolvedValue(undefined)

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getDueTasks: (...args: unknown[]) => mockGetDueTasks(...args),
  getScheduledTask: vi.fn(() => Promise.resolve(null)),
  markTaskExecuted: (...args: unknown[]) => mockMarkTaskExecuted(...args),
  markTaskFailed: (...args: unknown[]) => mockMarkTaskFailed(...args),
  updateNextExecution: (...args: unknown[]) => mockUpdateNextExecution(...args),
}))

const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

// Import after mocks
import { taskScheduler } from './task-scheduler'

const POLL_MS = 60000

describe('TaskScheduler startup resilience (SUP-224)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Reset the singleton so a lingering interval / isRunning never leaks.
    taskScheduler.stop()
    vi.useRealTimers()
  })

  it('does not wedge when the catch-up scan fails — stays active and self-heals on the next poll', async () => {
    vi.useFakeTimers()
    // The catch-up scan throws once (transient); later poll scans succeed.
    mockGetDueTasks
      .mockRejectedValueOnce(new Error('transient SQLite error'))
      .mockResolvedValue([])

    await expect(taskScheduler.start()).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)

    expect(taskScheduler.isActive()).toBe(true)
    expect(mockCaptureException).toHaveBeenCalledTimes(1)
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      tags: { component: 'task-scheduler', phase: 'poll' },
    })

    // The poll loop is real: advancing one interval re-scans (the self-heal).
    const callsAfterScan = mockGetDueTasks.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(mockGetDueTasks.mock.calls.length).toBeGreaterThan(callsAfterScan)
  })

  it('reports a failed poll cycle to Sentry and keeps polling', async () => {
    vi.useFakeTimers()
    mockGetDueTasks
      .mockResolvedValueOnce([]) // catch-up scan succeeds
      .mockRejectedValueOnce(new Error('poll-cycle SQLite error')) // first poll fails
      .mockResolvedValue([]) // recovers

    await taskScheduler.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockCaptureException).not.toHaveBeenCalled() // clean catch-up reports nothing

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tags: expect.objectContaining({ phase: 'poll' }) })
    )
    // A failed cycle must not stop the loop.
    expect(taskScheduler.isActive()).toBe(true)
    const calls = mockGetDueTasks.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(mockGetDueTasks.mock.calls.length).toBeGreaterThan(calls)
  })

  it('scans at once, then polls, and ignores a second start()', async () => {
    vi.useFakeTimers()
    mockGetDueTasks.mockResolvedValue([])

    await taskScheduler.start()
    expect(taskScheduler.isActive()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(mockGetDueTasks).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(mockGetDueTasks).toHaveBeenCalledTimes(2)

    // A redundant start() while active is a no-op and must not add a second job.
    await taskScheduler.start()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(mockGetDueTasks).toHaveBeenCalledTimes(3)
    expect(mockCaptureException).not.toHaveBeenCalled()

    taskScheduler.stop()
    expect(taskScheduler.isActive()).toBe(false)
  })
})
