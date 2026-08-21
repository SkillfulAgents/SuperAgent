import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// SUP-224 — Task scheduler startup must not wedge when the initial overdue scan
// fails.
//
// The scheduler now installs its periodic poll loop UNCONDITIONALLY (before the
// immediate catch-up scan), so a transient failure in that scan (e.g. a SQLite
// hiccup in getDueTasks) can't prevent polling. start() does NOT reject on such
// a failure — it reports to Sentry and lets the poll loop retry on the next
// tick, so isActive() stays true and the scheduler self-heals.
//
// Only the scheduled-task-service boundary and the error-reporting sink need
// mocking; when scans return []/throw, executeTask is never reached, so the
// heavy collaborators (containerManager, messagePersister, …) aren't exercised.
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

  it('does not wedge when the initial overdue scan fails — stays active and self-heals on the next poll', async () => {
    vi.useFakeTimers()
    // The immediate catch-up scan throws once (transient); later poll scans succeed.
    mockGetDueTasks
      .mockRejectedValueOnce(new Error('transient SQLite error'))
      .mockResolvedValue([])

    // start() must NOT reject — a failed catch-up scan is non-fatal now.
    await expect(taskScheduler.start()).resolves.toBeUndefined()

    // The bug was isActive() going false (or, pre-#231, wedged true with no
    // interval). Now the poll loop is installed regardless, so it stays active.
    expect(taskScheduler.isActive()).toBe(true)

    // The failure was reported to Sentry, tagged as the initial scan.
    expect(mockCaptureException).toHaveBeenCalledTimes(1)
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      tags: { component: 'task-scheduler', phase: 'initial-scan' },
    })

    // The poll loop is real: advancing one interval re-scans (the self-heal).
    const callsAfterStart = mockGetDueTasks.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(mockGetDueTasks.mock.calls.length).toBeGreaterThan(callsAfterStart)
  })

  it('reports a failed poll cycle to Sentry and keeps polling', async () => {
    vi.useFakeTimers()
    mockGetDueTasks
      .mockResolvedValueOnce([]) // immediate catch-up scan succeeds
      .mockRejectedValueOnce(new Error('poll-cycle SQLite error')) // first poll tick fails
      .mockResolvedValue([]) // recovers

    await taskScheduler.start()
    expect(taskScheduler.isActive()).toBe(true)
    expect(mockCaptureException).not.toHaveBeenCalled() // clean startup reports nothing

    // Fire the failing poll tick.
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

  it('installs the polling loop and stays active on a clean startup', async () => {
    vi.useFakeTimers()
    mockGetDueTasks.mockResolvedValue([])

    await taskScheduler.start()
    expect(taskScheduler.isActive()).toBe(true)

    // start() runs one immediate scan; the interval should add more over time.
    const callsAfterStart = mockGetDueTasks.mock.calls.length
    expect(callsAfterStart).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(mockGetDueTasks.mock.calls.length).toBeGreaterThan(callsAfterStart)

    // A redundant start() while active is a no-op and must not reset state or
    // install a second interval.
    await taskScheduler.start()
    expect(taskScheduler.isActive()).toBe(true)
    expect(mockCaptureException).not.toHaveBeenCalled() // the clean path never reports

    taskScheduler.stop()
    expect(taskScheduler.isActive()).toBe(false)
  })
})
