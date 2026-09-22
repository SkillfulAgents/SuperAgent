import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AppDatabase } from '@shared/lib/db'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
let testDb: AppDatabase

vi.mock('@shared/lib/db', () => ({
  get db() {
    return testDb
  },
}))

import {
  createScheduledTask,
  getScheduledTask,
  markTaskFailed,
  pauseScheduledTask,
  recordManualExecution,
  recordTaskSkip,
  rescheduleAfterFailure,
  resetScheduledTask,
  resumeScheduledTask,
  updateNextExecution,
} from './scheduled-task-service'

// The bookkeeping behind the scheduler's overlap guard: a held fire bumps the
// skip streak without moving the schedule, a failed fire moves the schedule
// without touching the guard's pointer, and a real fire or re-anchor clears
// the streak.

async function createRecurringTask(): Promise<string> {
  return createScheduledTask({
    agentSlug: 'test-agent',
    scheduleType: 'cron',
    scheduleExpression: '*/15 * * * *',
    prompt: 'Recurring test',
  })
}

async function createHeldTask(skips: number): Promise<string> {
  const taskId = await createRecurringTask()
  for (let i = 0; i < skips; i++) await recordTaskSkip(taskId)
  expect((await getScheduledTask(taskId))!.consecutiveSkips).toBe(skips)
  return taskId
}

describe('scheduled-task-service overlap-guard bookkeeping', () => {
  beforeEach(async () => {
    handle = await createTestDatabase()
    testDb = handle.db
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await handle.close()
  })

  describe('recordTaskSkip', () => {
    it('bumps the streak and leaves the schedule and execution stats alone', async () => {
      const taskId = await createRecurringTask()
      const before = (await getScheduledTask(taskId))!
      expect(before.consecutiveSkips).toBe(0)
      expect(before.lastSkippedAt).toBeNull()

      await recordTaskSkip(taskId)
      await recordTaskSkip(taskId)

      const after = (await getScheduledTask(taskId))!
      expect(after.consecutiveSkips).toBe(2)
      expect(after.lastSkippedAt?.getTime()).toBe(Date.parse('2024-06-15T12:00:00.000Z'))
      expect(after.nextExecutionAt.getTime()).toBe(before.nextExecutionAt.getTime())
      expect(after.executionCount).toBe(0)
      expect(after.lastExecutedAt).toBeNull()
    })

    it('is a no-op for a task that does not exist', async () => {
      await expect(recordTaskSkip('nonexistent-id')).resolves.toBeUndefined()
    })
  })

  describe('rescheduleAfterFailure', () => {
    it('moves the schedule but keeps the previous run, the streak, and the execution stats', async () => {
      const taskId = await createRecurringTask()
      await updateNextExecution(taskId, new Date('2024-06-15T12:15:00.000Z'), 'prev-session')
      await recordTaskSkip(taskId)
      const before = (await getScheduledTask(taskId))!

      const nextTime = new Date('2024-06-15T12:30:00.000Z')
      await rescheduleAfterFailure(taskId, nextTime)

      const after = (await getScheduledTask(taskId))!
      expect(after.nextExecutionAt.getTime()).toBe(nextTime.getTime())
      expect(after.lastSessionId).toBe('prev-session')
      expect(after.consecutiveSkips).toBe(1)
      expect(after.lastSkippedAt).not.toBeNull()
      expect(after.executionCount).toBe(1)
      expect(after.lastExecutedAt?.getTime()).toBe(before.lastExecutedAt?.getTime())
      expect(after.status).toBe('pending')
    })

    it('is a no-op for a task that does not exist', async () => {
      await expect(
        rescheduleAfterFailure('nonexistent-id', new Date('2024-06-15T13:00:00.000Z')),
      ).resolves.toBeUndefined()
    })
  })

  describe('clearing the streak', () => {
    it('updateNextExecution clears it on a fire', async () => {
      const taskId = await createHeldTask(2)

      await updateNextExecution(taskId, new Date('2024-06-15T13:00:00.000Z'), 'session-xyz')

      const task = (await getScheduledTask(taskId))!
      expect(task.consecutiveSkips).toBe(0)
      expect(task.lastSkippedAt).toBeNull()
      expect(task.lastSessionId).toBe('session-xyz')
    })

    it('recordManualExecution clears it (the manual run becomes the previous run)', async () => {
      const taskId = await createHeldTask(3)

      await recordManualExecution(taskId, 'manual-session')

      const task = (await getScheduledTask(taskId))!
      expect(task.consecutiveSkips).toBe(0)
      expect(task.lastSkippedAt).toBeNull()
      expect(task.lastSessionId).toBe('manual-session')
    })

    it('resumeScheduledTask clears it (the re-anchor drops the held fire)', async () => {
      const taskId = await createHeldTask(3)
      await pauseScheduledTask(taskId)

      expect(await resumeScheduledTask(taskId)).toBe(true)

      const task = (await getScheduledTask(taskId))!
      expect(task.consecutiveSkips).toBe(0)
      expect(task.lastSkippedAt).toBeNull()
    })

    it('resetScheduledTask clears it', async () => {
      const taskId = await createHeldTask(3)
      await markTaskFailed(taskId, 'boom')

      expect(await resetScheduledTask(taskId)).toBe(true)

      const task = (await getScheduledTask(taskId))!
      expect(task.consecutiveSkips).toBe(0)
      expect(task.lastSkippedAt).toBeNull()
    })
  })
})
