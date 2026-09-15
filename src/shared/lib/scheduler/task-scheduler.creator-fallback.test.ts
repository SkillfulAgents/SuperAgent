import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The scheduler must run each task under the user resolveAutomationUserId picks
// (creator, else agent owner). agentExists=false stops executeTaskInner early so
// the heavy collaborators (containers, sessions) stay out of reach.
const mockGetDueTasks = vi.fn()
vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getDueTasks: () => mockGetDueTasks(),
  getScheduledTask: vi.fn(() => Promise.resolve(null)),
  markTaskExecuted: vi.fn().mockResolvedValue(undefined),
  markTaskFailed: vi.fn().mockResolvedValue(undefined),
  updateNextExecution: vi.fn().mockResolvedValue(undefined),
}))

const mockAgentExists = vi.fn().mockResolvedValue(false)
vi.mock('@shared/lib/services/agent-service', () => ({
  agentExists: (...args: unknown[]) => mockAgentExists(...args),
}))

const mockResolveAutomationUserId = vi.fn((userId: string | null, _agentSlug: string) => userId)
const mockRunWithOptionalUser = vi.fn((_userId: string | null | undefined, fn: () => unknown) => fn())
vi.mock('@shared/lib/platform-attribution', () => ({
  resolveAutomationUserId: (userId: string | null, agentSlug: string) => mockResolveAutomationUserId(userId, agentSlug),
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
  mockResolveAutomationUserId.mockImplementation((userId) => userId)
})

afterEach(() => {
  taskScheduler.stop()
})

describe('TaskScheduler — run attribution', () => {
  it('runs the task under the user resolved for the creator and agent', async () => {
    mockResolveAutomationUserId.mockReturnValue('user_owner')
    mockGetDueTasks.mockResolvedValueOnce([dueTask('user_deleted')]).mockResolvedValue([])

    await taskScheduler.start()

    expect(mockResolveAutomationUserId).toHaveBeenCalledWith('user_deleted', 'agent-x')
    expect(mockRunWithOptionalUser).toHaveBeenCalledWith('user_owner', expect.any(Function))
    expect(mockAgentExists).toHaveBeenCalledWith('agent-x')
  })

  it('runs under the creator when resolution keeps them', async () => {
    mockGetDueTasks.mockResolvedValueOnce([dueTask('user_alive')]).mockResolvedValue([])

    await taskScheduler.start()

    expect(mockRunWithOptionalUser).toHaveBeenCalledWith('user_alive', expect.any(Function))
  })
})
