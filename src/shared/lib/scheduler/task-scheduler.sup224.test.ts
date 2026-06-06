import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// Mocks — only the scheduled-task-service boundary needs mocking.
// When the initial overdue scan throws (or returns []), executeTask is never
// reached, so the heavy collaborators (containerManager, messagePersister,
// etc.) are never exercised.
// ============================================================================

const mockGetDueTasks = vi.fn()
const mockMarkTaskExecuted = vi.fn().mockResolvedValue(undefined)
const mockMarkTaskFailed = vi.fn().mockResolvedValue(undefined)
const mockUpdateNextExecution = vi.fn().mockResolvedValue(undefined)

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getDueTasks: (...args: unknown[]) => mockGetDueTasks(...args),
  markTaskExecuted: (...args: unknown[]) => mockMarkTaskExecuted(...args),
  markTaskFailed: (...args: unknown[]) => mockMarkTaskFailed(...args),
  updateNextExecution: (...args: unknown[]) => mockUpdateNextExecution(...args),
}))

// Import after mocks
import { taskScheduler } from './task-scheduler'

// ============================================================================
// Tests
// ============================================================================

describe('TaskScheduler startup resilience (SUP-224)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    // Reset the singleton so a wedged isRunning never leaks across tests.
    taskScheduler.stop()
    vi.useRealTimers()
  })

  it('does not stay marked running when the initial overdue scan fails', async () => {
    // Simulate a transient SQLite error from the first getDueTasks() scan.
    mockGetDueTasks.mockRejectedValueOnce(new Error('transient SQLite error'))

    await expect(taskScheduler.start()).rejects.toThrow('transient SQLite error')

    // The bug: start() rejects with isRunning still true, wedging the scheduler
    // so every later start() short-circuits on the "Already running" guard.
    expect(taskScheduler.isActive()).toBe(false)
  })

  it('allows a later start() to install the polling loop after a failed startup scan', async () => {
    vi.useFakeTimers()

    // First start() fails on the initial scan and must roll back cleanly.
    mockGetDueTasks.mockRejectedValueOnce(new Error('transient SQLite error'))
    await expect(taskScheduler.start()).rejects.toThrow()
    expect(taskScheduler.isActive()).toBe(false)

    // A later start() should succeed and install the polling interval.
    mockGetDueTasks.mockResolvedValue([])
    await taskScheduler.start()
    expect(taskScheduler.isActive()).toBe(true)

    const callsAfterStart = mockGetDueTasks.mock.calls.length
    // Advancing by the poll interval must fire the installed interval, proving
    // the polling loop is actually running (not just the flag flipped).
    await vi.advanceTimersByTimeAsync(60000)
    expect(mockGetDueTasks.mock.calls.length).toBeGreaterThan(callsAfterStart)
  })

  it('installs the polling loop and stays active on a clean startup', async () => {
    vi.useFakeTimers()
    mockGetDueTasks.mockResolvedValue([])

    await taskScheduler.start()
    expect(taskScheduler.isActive()).toBe(true)

    // start() runs one immediate scan; the interval should add more over time.
    const callsAfterStart = mockGetDueTasks.mock.calls.length
    expect(callsAfterStart).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(60000)
    expect(mockGetDueTasks.mock.calls.length).toBeGreaterThan(callsAfterStart)

    // A redundant start() while active is a no-op and must not reset state.
    await taskScheduler.start()
    expect(taskScheduler.isActive()).toBe(true)

    taskScheduler.stop()
    expect(taskScheduler.isActive()).toBe(false)
  })
})
