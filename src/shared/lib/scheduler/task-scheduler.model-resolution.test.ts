import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ScheduledTask } from '@shared/lib/services/scheduled-task-service'

const mockGetDueTasks = vi.fn()
const mockMarkTaskExecuted = vi.fn()
const mockMarkTaskFailed = vi.fn()
const mockUpdateNextExecution = vi.fn()

vi.mock('@shared/lib/services/scheduled-task-service', () => ({
  getDueTasks: (...args: unknown[]) => mockGetDueTasks(...args),
  markTaskExecuted: (...args: unknown[]) => mockMarkTaskExecuted(...args),
  markTaskFailed: (...args: unknown[]) => mockMarkTaskFailed(...args),
  updateNextExecution: (...args: unknown[]) => mockUpdateNextExecution(...args),
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
    browserModel: 'claude-browser',
    dashboardBuilderModel: 'claude-dashboard',
  }),
}))

const mockReadAgentPreferences = vi.fn()

vi.mock('@shared/lib/services/agent-preferences-service', () => ({
  readAgentPreferences: (...args: unknown[]) => mockReadAgentPreferences(...args),
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

function createTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    agentSlug: 'agent-one',
    scheduleType: 'at',
    scheduleExpression: 'at 2026-06-26 10:00',
    prompt: 'Run the scheduled report',
    name: 'Daily report',
    status: 'pending',
    nextExecutionAt: new Date('2026-06-26T17:00:00.000Z'),
    lastExecutedAt: null,
    isRecurring: false,
    executionCount: 0,
    lastSessionId: null,
    createdBySessionId: null,
    createdByUserId: 'user-1',
    timezone: 'America/Los_Angeles',
    model: null,
    effort: null,
    resumeSessionId: null,
    createdAt: new Date('2026-06-26T16:00:00.000Z'),
    cancelledAt: null,
    pausedAt: null,
    ...overrides,
  }
}

describe('TaskScheduler model and effort resolution', () => {
  beforeEach(() => {
    taskScheduler.stop()
    vi.clearAllMocks()

    mockEnsureRunning.mockResolvedValue({ createSession: mockCreateSession })
    mockCreateSession.mockResolvedValue({ id: 'container-session-1' })
    mockSubscribeToSession.mockResolvedValue(undefined)
    mockTriggerScheduledSessionStarted.mockResolvedValue(undefined)
    mockRegisterSession.mockResolvedValue(undefined)
    mockGetSecretEnvVars.mockResolvedValue([])
    mockAgentExists.mockResolvedValue(true)
    mockGetSessionForScheduledExecution.mockResolvedValue(null)
    mockMarkTaskExecuted.mockResolvedValue(undefined)
    mockMarkTaskFailed.mockResolvedValue(undefined)
    mockUpdateNextExecution.mockResolvedValue(undefined)
    mockReadAgentPreferences.mockResolvedValue({})
  })

  afterEach(() => {
    taskScheduler.stop()
  })

  // Preference order: task override > agent default > global default.
  async function executeTask(overrides: Partial<ScheduledTask> = {}) {
    mockGetDueTasks.mockResolvedValue([createTask(overrides)])
    await taskScheduler.triggerExecution()
    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    return mockCreateSession.mock.calls[0][0]
  }

  it('uses the global default when neither task nor agent set one', async () => {
    const args = await executeTask()
    expect(args.model).toBe('claude-sonnet-4-20250514')
    expect(args.effort).toBeUndefined()
  })

  it('falls back to the agent default over the global default', async () => {
    mockReadAgentPreferences.mockResolvedValue({ defaultModel: 'opus', defaultEffort: 'high' })
    const args = await executeTask()
    expect(mockReadAgentPreferences).toHaveBeenCalledWith('agent-one')
    expect(args.model).toBe('opus')
    expect(args.effort).toBe('high')
  })

  it('prefers the task override over the agent default', async () => {
    mockReadAgentPreferences.mockResolvedValue({ defaultModel: 'opus', defaultEffort: 'high' })
    const args = await executeTask({ model: 'claude-haiku-4-5-20251001', effort: 'low' })
    expect(args.model).toBe('claude-haiku-4-5-20251001')
    expect(args.effort).toBe('low')
  })
})
