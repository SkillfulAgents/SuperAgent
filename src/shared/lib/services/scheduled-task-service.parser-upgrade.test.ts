import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { AppDatabase } from '@shared/lib/db'
import { scheduledTasks } from '@shared/lib/db/schema'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('../analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))

import {
  createScheduledTask,
  getDueTasks,
  getScheduledTask,
  listScheduledTasks,
  patchScheduledTask,
  pauseScheduledTask,
  resumeScheduledTask,
  updateNextExecution,
  updateTaskTimezone,
} from './scheduled-task-service'

describe('schedule parser upgrade persistence', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-07T18:00:00Z'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await handle.close()
  })

  const recurring = (expression = '0 8 * * 0', timezone = 'America/Chicago') => createScheduledTask({
    agentSlug: 'schedule-upgrade', scheduleType: 'cron',
    scheduleExpression: expression, timezone, prompt: 'Send the weekly review',
  })

  it('persists and selects the DST Sunday that the old parser skipped', async () => {
    const id = await recurring()
    expect((await getScheduledTask(id))?.nextExecutionAt.toISOString()).toBe('2026-03-08T13:00:00.000Z')
    vi.setSystemTime(new Date('2026-03-08T12:59:59Z'))
    expect(await getDueTasks()).toEqual([])
    vi.setSystemTime(new Date('2026-03-08T13:00:00Z'))
    expect((await getDueTasks()).map(task => task.id)).toEqual([id])
  })

  it('keeps a persisted due time until execution, and resumes after missed runs without erasing history', async () => {
    const id = await recurring('0 9 * * *', 'America/Los_Angeles')
    // A timestamp previously persisted by 5.5.0 remains authoritative until
    // execution or an explicit edit/re-anchor; reading the task must not reparse it.
    await updateNextExecution(id, new Date('2026-03-08T16:00:00Z'), 'previous-success')
    vi.setSystemTime(new Date('2026-03-08T17:00:00Z'))
    const due = (await getDueTasks())[0]
    expect(due.nextExecutionAt.toISOString()).toBe('2026-03-08T16:00:00.000Z')
    expect(await pauseScheduledTask(id)).toBe(true)
    expect(await getDueTasks()).toEqual([])
    vi.setSystemTime(new Date('2026-03-10T18:00:00Z'))
    expect(await resumeScheduledTask(id)).toBe(true)
    const resumed = (await getScheduledTask(id))!
    expect(resumed.status).toBe('pending')
    expect(resumed.nextExecutionAt.toISOString()).toBe('2026-03-11T16:00:00.000Z')
    expect(resumed.executionCount).toBe(1)
    expect(resumed.lastSessionId).toBe('previous-success')
  })

  it('recalculates a paused task in its new timezone without resuming it', async () => {
    const id = await recurring('0 9 * * *', 'UTC')
    await pauseScheduledTask(id)
    expect(await updateTaskTimezone(id, 'Asia/Kathmandu')).toBe(true)
    const task = (await getScheduledTask(id))!
    expect(task.status).toBe('paused')
    expect(task.timezone).toBe('Asia/Kathmandu')
    expect(task.nextExecutionAt.toISOString()).toBe('2026-03-08T03:15:00.000Z')
    expect(await getDueTasks()).toEqual([])
  })

  it.each(['1,1 * * * *', '0 0 * * L', '0 0 31 4,6 *'])(
    'rejects %s before creating or partially updating a persisted task', async (expression) => {
      await expect(recurring(expression)).rejects.toThrow()
      expect(await listScheduledTasks('schedule-upgrade')).toEqual([])
      const id = await recurring()
      const before = await getScheduledTask(id)
      await expect(patchScheduledTask(id, {
        scheduleExpression: expression, prompt: 'This must not be saved',
      })).rejects.toThrow()
      expect(await getScheduledTask(id)).toEqual(before)
    },
  )

  it.each([
    ['0,0 * * * *', '2026-03-07T19:00:00.000Z'],
    ['0 0 * * 0,7', '2026-03-08T06:00:00.000Z'],
    ['0 0 * * SUN,7', '2026-03-08T06:00:00.000Z'],
  ])('resumes legacy %s without rewriting its stored expression', async (expression, nextTime) => {
    const id = await recurring()
    await pauseScheduledTask(id)
    // Simulate an existing row accepted by the previous parser's duplicate-zero bug.
    await testDb.update(scheduledTasks).set({ scheduleExpression: expression })
      .where(eq(scheduledTasks.id, id))
    expect(await resumeScheduledTask(id)).toBe(true)
    const resumed = (await getScheduledTask(id))!
    expect(resumed.status).toBe('pending')
    expect(resumed.scheduleExpression).toBe(expression)
    expect(resumed.nextExecutionAt.toISOString()).toBe(nextTime)
  })

  it('persists the newly supported end-of-month one-time expression', async () => {
    const id = await createScheduledTask({
      agentSlug: 'schedule-upgrade', scheduleType: 'at',
      scheduleExpression: 'at the end of this month at 9am',
      timezone: 'UTC', prompt: 'Prepare the monthly review',
    })
    const task = (await getScheduledTask(id))!
    expect(task.nextExecutionAt.toISOString()).toBe('2026-03-31T09:00:00.000Z')
    expect(task.isRecurring).toBe(false)
  })
})
