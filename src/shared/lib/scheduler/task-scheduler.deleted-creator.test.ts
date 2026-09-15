import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A due task whose creator was deleted must be paused, not executed. Only the
// scheduled-task-service boundary and the orphan guard are mocked; the early
// return keeps the heavy collaborators (containers, sessions) out of reach.
const mockGetDueTasks = vi.fn()
vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getDueTasks: () => mockGetDueTasks(),
  getScheduledTask: vi.fn(() => Promise.resolve(null)),
  markTaskExecuted: vi.fn().mockResolvedValue(undefined),
  markTaskFailed: vi.fn().mockResolvedValue(undefined),
  updateNextExecution: vi.fn().mockResolvedValue(undefined),
}))

const mockIsOrphanedCreator = vi.fn((_userId: string | null | undefined) => false)
const mockPauseOrphanedAutomations = vi.fn().mockResolvedValue({ scheduledTasks: 1, webhookTriggers: 0 })
vi.mock('@shared/lib/services/orphaned-automations', () => ({
  isOrphanedCreator: (userId: string | null | undefined) => mockIsOrphanedCreator(userId),
  pauseOrphanedAutomations: (...args: unknown[]) => mockPauseOrphanedAutomations(...args),
}))

const mockAgentExists = vi.fn().mockResolvedValue(false)
vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: (...args: unknown[]) => mockAgentExists(...args),
}))

const mockRunWithOptionalUser = vi.fn((_userId: string | null | undefined, fn: () => unknown) => fn())
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: (userId: string | null | undefined, fn: () => unknown) => mockRunWithOptionalUser(userId, fn),
}))

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import { taskScheduler } from './task-scheduler'

function dueTask(createdByUserId: string | null) {
  return {
    id: 'task_1',
    agentSlug: 'agent-x',
    scheduleType: 'cron',
    scheduleExpression: '0 * * * *',
    prompt: 'run',
    name: 'Hourly',
    status: 'pending',
    nextExecutionAt: new Date('2026-09-14T10:00:00Z'),
    lastExecutedAt: null,
    isRecurring: true,
    executionCount: 0,
    lastSessionId: null,
    createdBySessionId: null,
    createdByUserId,
    resumeSessionId: null,
    timezone: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsOrphanedCreator.mockImplementation(() => false)
})

afterEach(() => {
  taskScheduler.stop()
})

describe('TaskScheduler — deleted creator', () => {
  it('pauses the creator’s automations and does not execute the task', async () => {
    mockIsOrphanedCreator.mockImplementation((userId) => userId === 'user_deleted')
    mockGetDueTasks.mockResolvedValueOnce([dueTask('user_deleted')]).mockResolvedValue([])

    await taskScheduler.start()

    expect(mockPauseOrphanedAutomations).toHaveBeenCalledWith('user_deleted', 'scheduled_task', {
      taskId: 'task_1',
      agentSlug: 'agent-x',
    })
    expect(mockRunWithOptionalUser).not.toHaveBeenCalled()
    expect(mockAgentExists).not.toHaveBeenCalled()
  })

  it('executes under the creator scope when the creator still exists', async () => {
    // agentExists=false makes executeTaskInner stop at the "agent gone" check,
    // which is enough to prove the guard let it through.
    mockGetDueTasks.mockResolvedValueOnce([dueTask('user_alive')]).mockResolvedValue([])

    await taskScheduler.start()

    expect(mockIsOrphanedCreator).toHaveBeenCalledWith('user_alive')
    expect(mockPauseOrphanedAutomations).not.toHaveBeenCalled()
    expect(mockRunWithOptionalUser).toHaveBeenCalledWith('user_alive', expect.any(Function))
  })
})
