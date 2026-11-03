import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '@shared/lib/db'
import { scheduledTasks } from '@shared/lib/db/schema'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))

// Keep the actor, scheduler, parser and persistence real; only the external
// container and session storage are doubles, as in the scheduler guard tests.
const mockCreateSession = vi.fn()
const mockEnsureRunning = vi.fn()
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
vi.mock('@shared/lib/agent-actor/live/live-sessions', async () => ({
  LiveSessions: (await import('@shared/lib/agent-actor/testing/live-sessions-double')).liveSessionsDouble(),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getEffectiveModels: () => ({
    agentModel: 'claude-sonnet-4-20250514',
    browserModel: 'claude-sonnet-4-20250514',
    dashboardBuilderModel: 'claude-sonnet-4-20250514',
  }),
}))
vi.mock('@shared/lib/services/agent-preferences-service', () => ({
  readAgentPreferences: vi.fn(async () => ({})),
}))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: { triggerScheduledSessionStarted: vi.fn(async () => {}) },
}))
const mockRegisterSession = vi.fn()
vi.mock('@shared/lib/services/session-service', () => ({
  getSessionMetadata: vi.fn(async () => null),
  getSessionForScheduledExecution: vi.fn(async () => null),
  registerSession: (...args: unknown[]) => mockRegisterSession(...args),
}))
vi.mock('@shared/lib/services/secrets-service', () => ({
  getSecretEnvVars: vi.fn(async () => []),
}))
vi.mock('@shared/lib/services/agent-service', () => ({ agentExists: vi.fn(async () => true) }))
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: (_userId: string | null | undefined, work: () => unknown) => work(),
}))
const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

import { backgroundSettled } from '@shared/lib/background'
import { getDueTasks, getScheduledTask } from '@shared/lib/services/scheduled-task-service'
import { taskScheduler } from './task-scheduler'

describe('stored cron expressions across a parser upgrade', () => {
  beforeEach(async () => {
    taskScheduler.stop()
    vi.clearAllMocks()
    handle = await createTestDatabase()
    testDb = handle.db
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-03-08T12:59:00Z'))
    mockEnsureRunning.mockResolvedValue({ createSession: mockCreateSession })
    mockCreateSession.mockReset()
      .mockResolvedValueOnce({ id: 'first-scheduled-session' })
      .mockResolvedValueOnce({ id: 'second-scheduled-session' })
    mockRegisterSession.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    taskScheduler.stop()
    await backgroundSettled()
    vi.useRealTimers()
    await handle.close()
  })

  it.each([
    {
      expression: '0,0 * * * *', timezone: 'UTC',
      slots: ['2026-03-08T13:00:00Z', '2026-03-08T14:00:00Z', '2026-03-08T15:00:00Z'],
    },
    {
      expression: '0 8 * * 0,7', timezone: 'America/Chicago',
      slots: ['2026-03-08T13:00:00Z', '2026-03-15T13:00:00Z', '2026-03-22T13:00:00Z'],
    },
  ])('executes $expression twice without losing its recurring schedule', async ({ expression, timezone, slots }) => {
    const taskId = crypto.randomUUID()
    const agentSlug = `legacy-schedule-${taskId}`
    // Simulate a row persisted before the upgrade, bypassing current creation
    // validation. Reading a legacy task must preserve its existing planned slot.
    await testDb.insert(scheduledTasks).values({
      id: taskId, agentSlug, scheduleType: 'cron', scheduleExpression: expression,
      prompt: 'Send the scheduled report', name: 'Legacy recurring report',
      status: 'pending', isRecurring: true, timezone,
      nextExecutionAt: new Date(slots[0]), createdAt: new Date(),
    })
    expect(await getDueTasks()).toEqual([])

    for (const [index, sessionId] of ['first-scheduled-session', 'second-scheduled-session'].entries()) {
      const plannedAt = new Date(slots[index])
      vi.setSystemTime(plannedAt)
      expect((await getDueTasks()).map(task => task.id)).toEqual([taskId])

      // This is the same scan, sequential dispatch, recording and error path
      // called by the scheduler's real polling interval.
      await taskScheduler.triggerExecution()

      const task = (await getScheduledTask(taskId))!
      expect(task.status).toBe('pending')
      expect(task.scheduleExpression).toBe(expression)
      expect(task.timezone).toBe(timezone)
      expect(task.executionCount).toBe(index + 1)
      expect(task.lastSessionId).toBe(sessionId)
      expect(task.lastExecutedAt).toEqual(plannedAt)
      expect(task.nextExecutionAt).toEqual(new Date(slots[index + 1]))
      expect(mockRegisterSession).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ slug: agentSlug }),
        sessionId,
        'Legacy recurring report',
        expect.objectContaining({
          isScheduledExecution: true, scheduledTaskId: taskId,
          scheduledExecutionAt: plannedAt.toISOString(),
        }),
      )
      expect(await getDueTasks()).toEqual([])
      await taskScheduler.triggerExecution()
      expect(mockCreateSession).toHaveBeenCalledTimes(index + 1)
      expect(mockCaptureException).not.toHaveBeenCalled()
    }
  })
})
