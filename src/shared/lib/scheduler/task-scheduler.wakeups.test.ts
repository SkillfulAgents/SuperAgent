import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '@shared/lib/db'
import { scheduledTasks } from '@shared/lib/db/schema'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { eq } from 'drizzle-orm'

// The scheduler, its wakeups, the schedule service, the parser and the database
// are all real, on a fake clock. Only the container and session storage are doubles.
let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))

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

const mockIsActive = vi.fn()
const mockIsAwaitingInput = vi.fn()
vi.mock('@shared/lib/agent-actor/live/live-sessions', async () => ({
  LiveSessions: (await import('@shared/lib/agent-actor/testing/live-sessions-double')).liveSessionsDouble({
    isActive: (...args) => mockIsActive(...args),
    isAwaitingInput: (...args) => mockIsAwaitingInput(...args),
  }),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getEffectiveModels: () => ({ agentModel: 'm', browserModel: 'm', dashboardBuilderModel: 'm' }),
  effectiveModelsFrom: () => ({ agentModel: 'm', browserModel: 'm', dashboardBuilderModel: 'm' }),
}))
vi.mock('@shared/lib/services/agent-preferences-service', () => ({ readAgentPreferences: vi.fn(async () => ({})) }))
vi.mock('@shared/lib/notifications/notification-manager', () => ({
  notificationManager: { triggerScheduledSessionStarted: vi.fn(async () => {}), triggerScheduledSessionResumed: vi.fn(async () => {}) },
}))
const mockRegisterSession = vi.fn()
vi.mock('@shared/lib/services/session-service', () => ({
  getSessionMetadata: vi.fn(async () => null),
  getSessionForScheduledExecution: vi.fn(async () => null),
  registerSession: (...args: unknown[]) => mockRegisterSession(...args),
}))
vi.mock('@shared/lib/services/secrets-service', () => ({ getSecretEnvVars: vi.fn(async () => []) }))
const mockAgentExists = vi.fn()
vi.mock('@shared/lib/services/agent-service', () => ({ agentExists: (...args: unknown[]) => mockAgentExists(...args) }))
const attributedTo: Array<string | null | undefined> = []
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithOptionalUser: (userId: string | null | undefined, work: () => unknown) => {
    attributedTo.push(userId)
    return work()
  },
}))
const mockCaptureException = vi.fn()
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))
const mockDeliverSessionWake = vi.fn()
vi.mock('./wake-delivery', () => ({
  deliverSessionWake: (...args: unknown[]) => mockDeliverSessionWake(...args),
}))

import { closeBackgroundWork, initializeBackgroundWork, taskManager } from '@shared/lib/background-work'
import { LocalTaskManager } from '@shared/lib/background-work/local-task-manager'
import { backgroundSettled } from '@shared/lib/background'
import { registerTasks } from '@shared/lib/background-work/testing/register-tasks'
import * as schedules from '@shared/lib/services/scheduled-task-service'
import { agentCronJobId } from './agent-cron-schema'
import { taskScheduler } from './task-scheduler'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const AGENT = 'wakeup-agent'
const NOW = new Date('2026-06-15T12:00:30Z')

const cronWakeups = () => (taskManager() as LocalTaskManager).scheduled().filter(job => job.taskType === 'agent.cron')
const wakeupAt = (id: string) => cronWakeups().find(job => job.id === agentCronJobId(id))?.nextRunAt
const sessionsStarted = () => mockCreateSession.mock.calls.length

async function insert(fields: Partial<typeof scheduledTasks.$inferInsert> & { id: string }) {
  await testDb.insert(scheduledTasks).values({
    agentSlug: AGENT,
    scheduleType: 'cron',
    scheduleExpression: '*/5 * * * *',
    prompt: 'Do the thing',
    status: 'pending',
    isRecurring: true,
    timezone: 'UTC',
    nextExecutionAt: new Date(NOW.getTime() + 5 * MINUTE),
    createdAt: new Date(),
    ...fields,
  })
  return fields.id
}

const row = async (id: string) => (await schedules.getScheduledTask(id))!

// One turn of the event loop, by a message port as the actor test transport takes
// them: the timers here are fake.
const turn = () => new Promise<void>((resolve) => {
  const { port1, port2 } = new MessageChannel()
  port1.onmessage = () => {
    port1.close()
    port2.close()
    resolve()
  }
  port2.postMessage(null)
})

/** Lets what a wakeup set off land. A test may be holding a run on purpose, so this gives up on one in the end. */
async function landed() {
  let idle = 0
  for (let turns = 0; turns < 500 && idle < 30; turns++) {
    await turn()
    idle = (taskManager() as LocalTaskManager).scheduled().some(job => job.running) ? 0 : idle + 1
  }
}

/**
 * Moves the clock one wakeup at a time, and waits at each for what it set off. Under
 * `npm run test:actor-transport` an actor op takes real turns of the event loop,
 * which a fake clock would run on past, so the next time would come from a clock
 * no fire ever saw.
 */
async function advance(ms: number) {
  const end = Date.now() + ms
  for (;;) {
    await landed()
    const upcoming = (taskManager() as LocalTaskManager).scheduled().map(job => job.nextRunAt).filter((at): at is number => at !== null && at > Date.now())
    await vi.advanceTimersByTimeAsync(Math.min(end, ...upcoming) - Date.now())
    if (Date.now() >= end) break
  }
  await landed()
}

describe('scheduled tasks fired by their wakeups', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    attributedTo.length = 0
    handle = await createTestDatabase()
    testDb = handle.db
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(NOW)
    registerTasks(taskScheduler)
    let sessions = 0
    mockEnsureRunning.mockResolvedValue({ createSession: mockCreateSession })
    mockCreateSession.mockReset().mockImplementation(async () => ({ id: `session-${++sessions}` }))
    mockRegisterSession.mockResolvedValue(undefined)
    mockAgentExists.mockResolvedValue(true)
    mockIsActive.mockReturnValue(false)
    mockIsAwaitingInput.mockReturnValue(false)
    mockDeliverSessionWake.mockResolvedValue({ outcome: 'delivered', sessionId: 'target' })
  })

  afterEach(async () => {
    taskScheduler.stop()
    await taskManager().stop()
    vi.useRealTimers()
    await backgroundSettled()
    await handle.close()
  })

  describe('rebuilding at startup', () => {
    it('sets a wakeup for each pending schedule from its record, and none for the rest', async () => {
      const inFive = new Date(NOW.getTime() + 5 * MINUTE)
      await insert({ id: 'cron', nextExecutionAt: inFive })
      await insert({ id: 'one-off', scheduleType: 'at', isRecurring: false, scheduleExpression: 'at tomorrow', nextExecutionAt: inFive })
      await insert({ id: 'paused', status: 'paused' })
      await insert({ id: 'executed', status: 'executed' })
      await insert({ id: 'cancelled', status: 'cancelled' })
      await insert({ id: 'failed', status: 'failed' })

      await taskScheduler.start()

      expect(cronWakeups().map(job => job.id).sort()).toEqual([agentCronJobId('cron'), agentCronJobId('one-off')])
      expect(wakeupAt('cron')).toBe(inFive.getTime())
      expect(sessionsStarted()).toBe(0)
    })

    it('fires a recurring schedule on time, then at each next time it computes', async () => {
      const first = new Date('2026-06-15T12:05:00Z')
      await insert({ id: 'cron', nextExecutionAt: first })
      await taskScheduler.start()

      await advance(first.getTime() - Date.now() - 1)
      expect(sessionsStarted()).toBe(0)
      await advance(1)
      expect(sessionsStarted()).toBe(1)
      expect((await row('cron')).nextExecutionAt).toEqual(new Date('2026-06-15T12:10:00Z'))
      expect((await row('cron')).executionCount).toBe(1)
      expect(wakeupAt('cron')).toBe(new Date('2026-06-15T12:10:00Z').getTime())

      await advance(5 * MINUTE)
      expect(sessionsStarted()).toBe(2)
      expect((await row('cron')).nextExecutionAt).toEqual(new Date('2026-06-15T12:15:00Z'))
    })

    it('fires a schedule that came due while the app was closed once, and moves it past the missed times', async () => {
      await insert({ id: 'cron', nextExecutionAt: new Date(NOW.getTime() - 3 * HOUR) })
      await taskScheduler.start()
      await advance(0)

      expect(sessionsStarted()).toBe(1)
      expect(mockRegisterSession.mock.calls[0][3]).toMatchObject({
        scheduledExecutionAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(),
      })
      expect((await row('cron')).nextExecutionAt).toEqual(new Date('2026-06-15T12:05:00Z'))
      await advance(4 * MINUTE)
      expect(sessionsStarted()).toBe(1)
    })

    it('fires an overdue one-off once at startup', async () => {
      await insert({ id: 'one-off', scheduleType: 'at', isRecurring: false, scheduleExpression: 'at noon', nextExecutionAt: new Date(NOW.getTime() - HOUR) })
      await taskScheduler.start()
      await advance(0)
      expect(sessionsStarted()).toBe(1)
      expect(await row('one-off')).toMatchObject({ status: 'executed', lastSessionId: 'session-1' })
      expect(cronWakeups()).toEqual([])
      await advance(HOUR)
      expect(sessionsStarted()).toBe(1)
    })

    it('stays active when the first read of the schedules fails, and reads them again a minute later', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await insert({ id: 'cron', nextExecutionAt: new Date(NOW.getTime() - HOUR) })
      const list = vi.spyOn(schedules, 'listPendingScheduledTaskIds').mockRejectedValueOnce(new Error('database is locked'))
      await expect(taskScheduler.start()).resolves.toBeUndefined()
      expect(taskScheduler.isActive()).toBe(true)
      expect(mockCaptureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'database is locked' }), { tags: { component: 'task-scheduler', phase: 'initial-scan' } })
      expect(cronWakeups()).toEqual([])

      await advance(MINUTE + 1)
      expect(sessionsStarted()).toBe(1)
      list.mockRestore()
      error.mockRestore()
    })
  })

  describe('following the records', () => {
    beforeEach(async () => {
      await taskScheduler.start()
    })

    it('wakes a schedule created after startup', async () => {
      const id = await schedules.createScheduledTask({ agentSlug: AGENT, scheduleType: 'cron', scheduleExpression: '*/5 * * * *', prompt: 'p', timezone: 'UTC' })
      expect(wakeupAt(id)).toBe(new Date('2026-06-15T12:05:00Z').getTime())
      await advance(5 * MINUTE)
      expect(sessionsStarted()).toBe(1)
    })

    it('moves the wakeup when the schedule is edited, earlier or later', async () => {
      await insert({ id: 'cron' })
      await schedules.syncScheduleWakeup('cron')

      await schedules.updateScheduleExpression('cron', '0 13 * * *')
      expect(wakeupAt('cron')).toBe(new Date('2026-06-15T13:00:00Z').getTime())
      await advance(10 * MINUTE)
      expect(sessionsStarted()).toBe(0)

      await schedules.updateScheduleExpression('cron', '15 12 * * *')
      expect(wakeupAt('cron')).toBe(new Date('2026-06-15T12:15:00Z').getTime())
      await advance(5 * MINUTE)
      expect(sessionsStarted()).toBe(1)
    })

    it('leaves the wakeup alone when only the prompt changes, and fires with the new prompt', async () => {
      await insert({ id: 'cron' })
      await schedules.syncScheduleWakeup('cron')
      const before = wakeupAt('cron')
      await schedules.updateTaskPrompt('cron', 'A new prompt')
      expect(wakeupAt('cron')).toBe(before)
      await advance(5 * MINUTE)
      expect(mockCreateSession.mock.calls[0][0]).toMatchObject({ initialMessage: 'A new prompt' })
    })

    it('moves the wakeup when the timezone changes', async () => {
      await insert({ id: 'cron', scheduleExpression: '0 13 * * *', nextExecutionAt: new Date('2026-06-15T13:00:00Z') })
      await schedules.syncScheduleWakeup('cron')
      await schedules.updateTaskTimezone('cron', 'America/New_York')
      expect(wakeupAt('cron')).toBe(new Date('2026-06-15T17:00:00Z').getTime())
    })

    it('cancels the wakeup on pause, and sets it from the recomputed time on resume, skipping what was missed', async () => {
      await insert({ id: 'cron' })
      await schedules.syncScheduleWakeup('cron')
      await schedules.pauseScheduledTask('cron')
      expect(wakeupAt('cron')).toBeUndefined()

      await advance(HOUR)
      expect(sessionsStarted()).toBe(0)

      await schedules.resumeScheduledTask('cron')
      expect(wakeupAt('cron')).toBe(new Date('2026-06-15T13:05:00Z').getTime())
      await advance(5 * MINUTE)
      expect(sessionsStarted()).toBe(1)
    })

    it('cancels the wakeup on cancel and on delete', async () => {
      await insert({ id: 'cancelled' })
      await insert({ id: 'deleted' })
      await schedules.syncScheduleWakeup('cancelled')
      await schedules.syncScheduleWakeup('deleted')
      await schedules.cancelScheduledTask('cancelled')
      await schedules.deleteScheduledTask('deleted')
      expect(cronWakeups()).toEqual([])
      await advance(HOUR)
      expect(sessionsStarted()).toBe(0)
    })

    it('sets the wakeup again when a failed schedule is reset', async () => {
      await insert({ id: 'cron', status: 'failed' })
      await schedules.resetScheduledTask('cron')
      expect(wakeupAt('cron')).toBe(new Date('2026-06-15T12:05:00Z').getTime())
    })

    it('replaces the wakeup of a session wake that a new one replaces', async () => {
      const first = await schedules.createSessionWake({ agentSlug: AGENT, sessionId: 's', scheduleExpression: 'in 10 minutes', note: 'n' })
      expect(wakeupAt(first.taskId)).toBe(NOW.getTime() + 10 * MINUTE)
      const second = await schedules.createSessionWake({ agentSlug: AGENT, sessionId: 's', scheduleExpression: 'in 20 minutes', note: 'n' })
      expect(second.replaced?.id).toBe(first.taskId)
      expect(wakeupAt(first.taskId)).toBeUndefined()
      expect(wakeupAt(second.taskId)).toBe(NOW.getTime() + 20 * MINUTE)
    })

    it('ends with the wakeup the last of several close writes asks for', async () => {
      await insert({ id: 'cron' })
      await Promise.all([
        schedules.updateScheduleExpression('cron', '0 13 * * *'),
        schedules.updateScheduleExpression('cron', '0 14 * * *'),
        schedules.updateScheduleExpression('cron', '0 15 * * *'),
      ])
      expect(wakeupAt('cron')).toBe((await row('cron')).nextExecutionAt.getTime())
    })

    it('recovers a wakeup whose update failed outright', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await insert({ id: 'cron', status: 'failed' })
      const at = vi.spyOn(taskManager(), 'at').mockRejectedValueOnce(new Error('no timers today'))
      await expect(schedules.resetScheduledTask('cron')).resolves.toBe(true)
      expect(mockCaptureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'no timers today' }), expect.objectContaining({ tags: { component: 'task-scheduler', phase: 'sync-wakeup' } }))
      at.mockRestore()

      // The look-again wakeup finds the record pending, and follows it.
      expect(wakeupAt('cron')).toBe(Date.now() + MINUTE)
      await advance(MINUTE)
      expect(wakeupAt('cron')).toBe((await row('cron')).nextExecutionAt.getTime())
      error.mockRestore()
    })
  })

  describe('what a wakeup does', () => {
    beforeEach(async () => {
      await taskScheduler.start()
    })

    async function armed(fields: Parameters<typeof insert>[0]) {
      await insert(fields)
      await schedules.syncScheduleWakeup(fields.id)
    }

    it('acts for the user who created the schedule', async () => {
      await armed({ id: 'cron', nextExecutionAt: new Date(NOW.getTime() + 1_000), createdByUserId: 'user-1' })
      await advance(1_000)
      expect(attributedTo).toEqual(['user-1'])
    })

    it('finishes once the run is accepted, without waiting for the session to end', async () => {
      await armed({ id: 'one-off', scheduleType: 'at', isRecurring: false, nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      await advance(1_000)
      expect(sessionsStarted()).toBe(1)
      expect((taskManager() as LocalTaskManager).scheduled()).toEqual([])
    })

    it('executes due tasks one at a time, whatever comes due together', async () => {
      const at = new Date(NOW.getTime() + 1_000)
      await armed({ id: 'a', nextExecutionAt: at })
      await armed({ id: 'b', nextExecutionAt: at })
      await armed({ id: 'c', nextExecutionAt: at })
      let running = 0
      let peak = 0
      let release!: () => void
      mockEnsureRunning.mockImplementation(async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise<void>((resolve) => { release = resolve })
        running -= 1
        return { createSession: mockCreateSession }
      })
      await advance(1_000)
      expect(mockEnsureRunning).toHaveBeenCalledTimes(1)
      for (const started of [2, 3]) {
        release()
        await advance(0)
        expect(mockEnsureRunning).toHaveBeenCalledTimes(started)
      }
      release()
      await advance(0)
      expect(peak).toBe(1)
      expect(sessionsStarted()).toBe(3)
    })

    it('holds a fire while the previous run is busy, looking again each minute, and fires once when it is free', async () => {
      const due = new Date(NOW.getTime() + 1_000)
      await armed({ id: 'cron', nextExecutionAt: due, lastSessionId: 'previous-run' })
      mockIsActive.mockReturnValue(true)

      await advance(1_000)
      expect(sessionsStarted()).toBe(0)
      expect(await row('cron')).toMatchObject({ consecutiveSkips: 1, nextExecutionAt: due })

      // No tight loop: nothing more until the next look.
      await advance(MINUTE - 1)
      expect((await row('cron')).consecutiveSkips).toBe(1)
      await advance(1)
      expect(await row('cron')).toMatchObject({ consecutiveSkips: 2, nextExecutionAt: due })
      await advance(MINUTE)
      expect((await row('cron')).consecutiveSkips).toBe(3)

      mockIsActive.mockReturnValue(false)
      await advance(MINUTE)
      expect(sessionsStarted()).toBe(1)
      // The occurrence it held is the one it fires.
      expect(mockRegisterSession.mock.calls[0][3]).toMatchObject({ scheduledExecutionAt: due.toISOString() })
      expect(await row('cron')).toMatchObject({ consecutiveSkips: 0, executionCount: 1 })
      expect((await row('cron')).nextExecutionAt.getTime()).toBeGreaterThan(due.getTime())
    })

    it('holds nothing for a previous run parked on user input', async () => {
      await armed({ id: 'cron', nextExecutionAt: new Date(NOW.getTime() + 1_000), lastSessionId: 'previous-run' })
      mockIsActive.mockReturnValue(true)
      mockIsAwaitingInput.mockReturnValue(true)
      await advance(1_000)
      expect(sessionsStarted()).toBe(1)
    })

    // Fires came from a poll, so a cron with a seconds field never fired more than
    // once a minute. Exact wakeups must not turn it into one session every 10 s.
    it('fires a cron with a seconds field at most once a minute', async () => {
      await armed({ id: 'cron', scheduleExpression: '*/10 * * * * *', nextExecutionAt: new Date(NOW.getTime() + 10_000) })
      await advance(5 * MINUTE)
      expect(sessionsStarted()).toBeGreaterThanOrEqual(4)
      expect(sessionsStarted()).toBeLessThanOrEqual(5)
    })

    it('keeps an every-minute cron on its minute', async () => {
      await armed({ id: 'cron', scheduleExpression: '* * * * *', nextExecutionAt: new Date('2026-06-15T12:01:00Z') })
      await advance(30_000)
      expect(sessionsStarted()).toBe(1)
      for (let minute = 2; minute <= 6; minute++) {
        await advance(MINUTE)
        expect(sessionsStarted()).toBe(minute)
        expect(wakeupAt('cron')).toBe(new Date(`2026-06-15T12:0${minute + 1}:00Z`).getTime())
      }
    })

    it('moves a recurring schedule past a failed fire, keeping the guard on the previous run', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await armed({ id: 'cron', nextExecutionAt: new Date('2026-06-15T12:05:00Z'), lastSessionId: 'previous-run' })
      mockEnsureRunning.mockRejectedValueOnce(new Error('runtime down'))
      await advance(5 * MINUTE)
      expect(await row('cron')).toMatchObject({ status: 'pending', executionCount: 0, lastSessionId: 'previous-run' })
      expect((await row('cron')).nextExecutionAt).toEqual(new Date('2026-06-15T12:10:00Z'))
      expect(wakeupAt('cron')).toBe(new Date('2026-06-15T12:10:00Z').getTime())
      await advance(5 * MINUTE)
      expect(sessionsStarted()).toBe(1)
      error.mockRestore()
    })

    it('marks a one-off failed when its fire fails, and is done with it', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await armed({ id: 'one-off', scheduleType: 'at', isRecurring: false, nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      mockEnsureRunning.mockRejectedValueOnce(new Error('runtime down'))
      await advance(1_000)
      expect((await row('one-off')).status).toBe('failed')
      expect(cronWakeups()).toEqual([])
      error.mockRestore()
    })

    it('looks again when a failed one-off cannot be marked failed, rather than dropping it', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await armed({ id: 'one-off', scheduleType: 'at', isRecurring: false, nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      mockEnsureRunning.mockRejectedValueOnce(new Error('runtime down'))
      const mark = vi.spyOn(schedules, 'markTaskFailed').mockRejectedValueOnce(new Error('database is locked'))
      await advance(1_000)
      expect((await row('one-off')).status).toBe('pending')
      expect(wakeupAt('one-off')).toBe(Date.now() + MINUTE)
      await advance(MINUTE)
      expect(sessionsStarted()).toBe(1)
      expect((await row('one-off')).status).toBe('executed')
      mark.mockRestore()
      error.mockRestore()
    })

    it('marks a schedule failed when its agent is gone', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await armed({ id: 'cron', nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      mockAgentExists.mockResolvedValue(false)
      await advance(1_000)
      expect((await row('cron')).status).toBe('failed')
      expect(cronWakeups()).toEqual([])
      error.mockRestore()
    })

    it('looks again a minute later when the record cannot be read, rather than dropping the schedule', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await armed({ id: 'cron', nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      const read = vi.spyOn(schedules, 'getScheduledTask').mockRejectedValueOnce(new Error('database is locked'))
      await advance(1_000)
      expect(sessionsStarted()).toBe(0)
      expect(mockCaptureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'database is locked' }), expect.objectContaining({ tags: { component: 'task-scheduler', phase: 'poll' } }))
      await advance(MINUTE)
      expect(sessionsStarted()).toBe(1)
      read.mockRestore()
      error.mockRestore()
    })

    it('follows a record that moved without its wakeup: the record decides', async () => {
      await armed({ id: 'cron', nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      const later = new Date(NOW.getTime() + 30 * MINUTE)
      await testDb.update(scheduledTasks).set({ nextExecutionAt: later }).where(eq(scheduledTasks.id, 'cron'))
      await advance(1_000)
      expect(sessionsStarted()).toBe(0)
      expect(wakeupAt('cron')).toBe(later.getTime())
      await advance(30 * MINUTE)
      expect(sessionsStarted()).toBe(1)
    })

    it('does nothing for a schedule that is gone or no longer pending', async () => {
      await armed({ id: 'deleted', nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      await armed({ id: 'paused', nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      // As an agent's deletion does: the rows go, with no word to the wakeup.
      await testDb.delete(scheduledTasks).where(eq(scheduledTasks.id, 'deleted'))
      await testDb.update(scheduledTasks).set({ status: 'paused' }).where(eq(scheduledTasks.id, 'paused'))
      await advance(1_000)
      expect(sessionsStarted()).toBe(0)
      expect(cronWakeups()).toEqual([])
    })

    it('runs an edit that lands during a fire after that fire, with no second session for one occurrence', async () => {
      await armed({ id: 'cron', nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      let release!: () => void
      mockEnsureRunning.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return { createSession: mockCreateSession }
      })
      await advance(1_000)
      expect(mockEnsureRunning).toHaveBeenCalledTimes(1)

      await schedules.updateTaskTimezone('cron', 'America/New_York')
      await advance(10 * MINUTE)
      expect(sessionsStarted()).toBe(0)
      release()
      await advance(0)
      expect(sessionsStarted()).toBe(1)
      // Whatever time the record ends up on, it has a wakeup for it.
      expect(wakeupAt('cron')).toBe((await row('cron')).nextExecutionAt.getTime())
    })

    it('does not start a wakeup that was cancelled while it waited its turn', async () => {
      await armed({ id: 'first', nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      await armed({ id: 'second', nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      let release!: () => void
      mockEnsureRunning.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return { createSession: mockCreateSession }
      })
      await advance(1_000)
      await schedules.pauseScheduledTask('second')
      release()
      await advance(0)
      expect(sessionsStarted()).toBe(1)
      expect((await row('second')).status).toBe('paused')
    })

    it('fires a schedule due during a sleep within a minute of waking', async () => {
      const due = NOW.getTime() + 30 * MINUTE
      await armed({ id: 'cron', nextExecutionAt: new Date(due) })
      await advance(5 * MINUTE)
      // Process timers stop while the machine sleeps; the clock does not.
      vi.setSystemTime(due + 2 * HOUR)
      await advance(MINUTE)
      expect(sessionsStarted()).toBe(1)
    })

    it('waits for a far-off schedule, past the limit of one timer', async () => {
      const due = NOW.getTime() + 90 * 24 * HOUR
      await armed({ id: 'one-off', scheduleType: 'at', isRecurring: false, nextExecutionAt: new Date(due) })
      await advance(89 * 24 * HOUR)
      expect(sessionsStarted()).toBe(0)
      await advance(24 * HOUR)
      expect(sessionsStarted()).toBe(1)
    })
  })

  describe('session wakes', () => {
    beforeEach(async () => {
      await taskScheduler.start()
    })

    const wake = async (fields: Partial<Parameters<typeof insert>[0]> = {}) => {
      await insert({
        id: 'wake', scheduleType: 'at', isRecurring: false, scheduleExpression: 'in 1 minute',
        resumeSessionId: 'target', nextExecutionAt: new Date(NOW.getTime() + 1_000), ...fields,
      })
      await schedules.syncScheduleWakeup('wake')
    }

    it('delivers at its time, and creates no session', async () => {
      await wake()
      await advance(1_000)
      expect(mockDeliverSessionWake).toHaveBeenCalledWith(expect.objectContaining({ id: 'wake' }), 'scheduled')
      expect(sessionsStarted()).toBe(0)
      expect(cronWakeups()).toEqual([])
    })

    it('retries a transient failure each minute, then fails it past the retry window', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await wake()
      mockDeliverSessionWake.mockRejectedValue(new Error('container unreachable'))
      await advance(1_000)
      expect(mockDeliverSessionWake).toHaveBeenCalledTimes(1)
      expect((await row('wake')).status).toBe('pending')

      await advance(MINUTE)
      expect(mockDeliverSessionWake).toHaveBeenCalledTimes(2)
      expect((await row('wake')).status).toBe('pending')

      await advance(6 * HOUR)
      expect((await row('wake')).status).toBe('failed')
      expect(cronWakeups()).toEqual([])
      const attempts = mockDeliverSessionWake.mock.calls.length
      await advance(HOUR)
      expect(mockDeliverSessionWake).toHaveBeenCalledTimes(attempts)
      error.mockRestore()
    })

    it('looks again when a manual wake holds the claim, and finds it done', async () => {
      await wake()
      mockDeliverSessionWake.mockResolvedValueOnce({ outcome: 'in-flight' })
      await advance(1_000)
      expect(wakeupAt('wake')).toBe(Date.now() + MINUTE)
      await schedules.markTaskExecuted('wake', 'target')
      await advance(MINUTE)
      expect(mockDeliverSessionWake).toHaveBeenCalledTimes(1)
      expect(cronWakeups()).toEqual([])
    })

    it('fails a wake whose session is gone', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      await wake()
      mockDeliverSessionWake.mockResolvedValueOnce({ outcome: 'session-missing' })
      await advance(1_000)
      expect((await row('wake')).status).toBe('failed')
      expect(cronWakeups()).toEqual([])
      error.mockRestore()
    })
  })

  describe('stopping', () => {
    it('fires nothing once stopped, and leaves the schedules as they are', async () => {
      await insert({ id: 'cron', nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      await taskScheduler.start()
      taskScheduler.stop()
      await taskManager().stop()
      await advance(HOUR)
      expect(sessionsStarted()).toBe(0)
      expect(await row('cron')).toMatchObject({ status: 'pending', executionCount: 0 })
    })

    it('does not start one still waiting its turn when dispatch stops', async () => {
      await insert({ id: 'first', nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      await insert({ id: 'second', nextExecutionAt: new Date(NOW.getTime() + 1_000) })
      await taskScheduler.start()
      let release!: () => void
      mockEnsureRunning.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return { createSession: mockCreateSession }
      })
      await advance(1_000)
      await taskManager().stop()
      taskScheduler.stop()
      release()
      await advance(0)
      // The first was already starting, and keeps its record; the second stays due.
      expect(sessionsStarted()).toBe(1)
      expect(await row('second')).toMatchObject({ status: 'pending', executionCount: 0 })
    })

    it('rebuilds from the records on the next start, in a fresh manager', async () => {
      await insert({ id: 'cron', nextExecutionAt: new Date(NOW.getTime() + 5 * MINUTE) })
      await taskScheduler.start()
      taskScheduler.stop()
      await taskManager().stop()

      await closeBackgroundWork()
      await initializeBackgroundWork(new LocalTaskManager())
      registerTasks(taskScheduler)
      expect(cronWakeups()).toEqual([])
      await taskScheduler.start()
      expect(wakeupAt('cron')).toBe(NOW.getTime() + 5 * MINUTE)
    })

    it('does nothing if a wakeup fires before the scheduler has started', async () => {
      const id = await schedules.createScheduledTask({ agentSlug: AGENT, scheduleType: 'cron', scheduleExpression: '*/5 * * * *', prompt: 'p', timezone: 'UTC' })
      await advance(5 * MINUTE)
      expect(sessionsStarted()).toBe(0)
      // Starting picks it up from its record, overdue by then.
      await taskScheduler.start()
      await advance(0)
      expect(sessionsStarted()).toBe(1)
      expect((await row(id)).executionCount).toBe(1)
    })
  })
})
