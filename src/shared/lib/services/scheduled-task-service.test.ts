import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

// We need to set up a test database before importing the service
let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

// Mock the db module
vi.mock('../db', async () => {
  return {
    get db() {
      return testDb
    },
    get sqlite() {
      return testSqlite
    },
  }
})

// Import after mocking
import {
  createScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  listPendingScheduledTasks,
  getDueTasks,
  cancelScheduledTask,
  markTaskExecuted,
  updateNextExecution,
  markTaskFailed,
  resetScheduledTask,
  deleteScheduledTask,
} from './scheduled-task-service'

describe('scheduled-task-service', () => {
  beforeEach(async () => {
    // Create a temp directory for the test database
    testDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'scheduled-task-test-')
    )

    // Create an in-memory SQLite database
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })

    // Run migrations
    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })

    // Mock timers for predictable dates
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  // ============================================================================
  // createScheduledTask Tests
  // ============================================================================

  describe('createScheduledTask', () => {
    it('creates a one-time task with "at" syntax', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 1 hour',
        prompt: 'Do something',
        name: 'Test Task',
      })

      expect(taskId).toBeDefined()
      expect(typeof taskId).toBe('string')

      const task = await getScheduledTask(taskId)
      expect(task).not.toBeNull()
      expect(task!.agentSlug).toBe('test-agent')
      expect(task!.scheduleType).toBe('at')
      expect(task!.scheduleExpression).toBe('at now + 1 hour')
      expect(task!.prompt).toBe('Do something')
      expect(task!.name).toBe('Test Task')
      expect(task!.status).toBe('pending')
      expect(task!.isRecurring).toBe(false)
      expect(task!.executionCount).toBe(0)
    })

    it('creates a recurring task with cron syntax', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'cron',
        scheduleExpression: '*/15 * * * *',
        prompt: 'Do something regularly',
      })

      const task = await getScheduledTask(taskId)
      expect(task!.scheduleType).toBe('cron')
      expect(task!.isRecurring).toBe(true)
    })

    it('calculates correct nextExecutionAt for "at" tasks', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 2 hours',
        prompt: 'Test',
      })

      const task = await getScheduledTask(taskId)
      const expectedTime = new Date('2024-06-15T14:00:00.000Z')
      expect(task!.nextExecutionAt.getTime()).toBe(expectedTime.getTime())
    })

    it('stores createdBySessionId when provided', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 1 hour',
        prompt: 'Test',
        createdBySessionId: 'session-123',
      })

      const task = await getScheduledTask(taskId)
      expect(task!.createdBySessionId).toBe('session-123')
    })
  })

  // ============================================================================
  // listScheduledTasks Tests
  // ============================================================================

  describe('listScheduledTasks', () => {
    it('lists all tasks for an agent', async () => {
      await createScheduledTask({
        agentSlug: 'agent-1',
        scheduleType: 'at',
        scheduleExpression: 'at now + 1 hour',
        prompt: 'Task 1',
      })

      await createScheduledTask({
        agentSlug: 'agent-1',
        scheduleType: 'cron',
        scheduleExpression: '0 * * * *',
        prompt: 'Task 2',
      })

      await createScheduledTask({
        agentSlug: 'agent-2',
        scheduleType: 'at',
        scheduleExpression: 'at now + 1 hour',
        prompt: 'Task 3',
      })

      const tasks = await listScheduledTasks('agent-1')
      expect(tasks).toHaveLength(2)
      expect(tasks.every(t => t.agentSlug === 'agent-1')).toBe(true)
    })

    it('returns empty array for agent with no tasks', async () => {
      const tasks = await listScheduledTasks('nonexistent-agent')
      expect(tasks).toEqual([])
    })
  })

  // ============================================================================
  // listPendingScheduledTasks Tests
  // ============================================================================

  describe('listPendingScheduledTasks', () => {
    it('only lists pending tasks', async () => {
      const taskId1 = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 1 hour',
        prompt: 'Pending task',
      })

      const taskId2 = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 2 hours',
        prompt: 'Will be cancelled',
      })

      await cancelScheduledTask(taskId2)

      const pendingTasks = await listPendingScheduledTasks('test-agent')
      expect(pendingTasks).toHaveLength(1)
      expect(pendingTasks[0].id).toBe(taskId1)
    })
  })

  // ============================================================================
  // getDueTasks Tests
  // ============================================================================

  describe('getDueTasks', () => {
    it('returns tasks where nextExecutionAt is in the past', async () => {
      // Create a task due in the past (simulate by advancing time)
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 30 minutes',
        prompt: 'Due task',
      })

      // Initially, no tasks should be due
      let dueTasks = await getDueTasks()
      expect(dueTasks).toHaveLength(0)

      // Advance time by 1 hour
      vi.setSystemTime(new Date('2024-06-15T13:00:00.000Z'))

      // Now the task should be due
      dueTasks = await getDueTasks()
      expect(dueTasks).toHaveLength(1)
      expect(dueTasks[0].id).toBe(taskId)
    })

    it('does not return cancelled tasks', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 30 minutes',
        prompt: 'Cancelled task',
      })

      await cancelScheduledTask(taskId)

      // Advance time
      vi.setSystemTime(new Date('2024-06-15T13:00:00.000Z'))

      const dueTasks = await getDueTasks()
      expect(dueTasks).toHaveLength(0)
    })

    it('does not return executed tasks', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 30 minutes',
        prompt: 'Executed task',
      })

      await markTaskExecuted(taskId, 'session-123')

      // Advance time
      vi.setSystemTime(new Date('2024-06-15T13:00:00.000Z'))

      const dueTasks = await getDueTasks()
      expect(dueTasks).toHaveLength(0)
    })
  })

  // ============================================================================
  // cancelScheduledTask Tests
  // ============================================================================

  describe('cancelScheduledTask', () => {
    it('sets status to cancelled', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 1 hour',
        prompt: 'Test',
      })

      const result = await cancelScheduledTask(taskId)
      expect(result).toBe(true)

      const task = await getScheduledTask(taskId)
      expect(task!.status).toBe('cancelled')
      expect(task!.cancelledAt).not.toBeNull()
    })

    it('returns false for non-pending tasks', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 1 hour',
        prompt: 'Test',
      })

      // Cancel once
      await cancelScheduledTask(taskId)

      // Try to cancel again
      const result = await cancelScheduledTask(taskId)
      expect(result).toBe(false)
    })

    it('returns false for nonexistent tasks', async () => {
      const result = await cancelScheduledTask('nonexistent-id')
      expect(result).toBe(false)
    })
  })

  // ============================================================================
  // markTaskExecuted Tests
  // ============================================================================

  describe('markTaskExecuted', () => {
    it('sets status to executed and records session', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 1 hour',
        prompt: 'Test',
      })

      await markTaskExecuted(taskId, 'session-abc')

      const task = await getScheduledTask(taskId)
      expect(task!.status).toBe('executed')
      expect(task!.lastSessionId).toBe('session-abc')
      expect(task!.lastExecutedAt).not.toBeNull()
      expect(task!.executionCount).toBe(1)
    })
  })

  // ============================================================================
  // updateNextExecution Tests
  // ============================================================================

  describe('updateNextExecution', () => {
    it('updates nextExecutionAt and increments executionCount', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'cron',
        scheduleExpression: '*/15 * * * *',
        prompt: 'Recurring test',
      })

      const task = await getScheduledTask(taskId)
      const initialCount = task!.executionCount

      const newTime = new Date('2024-06-15T13:00:00.000Z')
      await updateNextExecution(taskId, newTime, 'session-xyz')

      const updatedTask = await getScheduledTask(taskId)
      expect(updatedTask!.nextExecutionAt.getTime()).toBe(newTime.getTime())
      expect(updatedTask!.lastSessionId).toBe('session-xyz')
      expect(updatedTask!.executionCount).toBe(initialCount + 1)
      expect(updatedTask!.status).toBe('pending') // Should stay pending for recurring
    })
  })

  // ============================================================================
  // markTaskFailed Tests
  // ============================================================================

  describe('markTaskFailed', () => {
    it('sets status to failed', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 1 hour',
        prompt: 'Test',
      })

      await markTaskFailed(taskId, 'Something went wrong')

      const task = await getScheduledTask(taskId)
      expect(task!.status).toBe('failed')
      expect(task!.lastExecutedAt).not.toBeNull()
    })
  })

  // ============================================================================
  // resetScheduledTask Tests
  // ============================================================================

  describe('resetScheduledTask', () => {
    it('resets a failed task back to pending', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'cron',
        scheduleExpression: '*/15 * * * *',
        prompt: 'Test',
      })

      await markTaskFailed(taskId, 'Error')

      const result = await resetScheduledTask(taskId)
      expect(result).toBe(true)

      const task = await getScheduledTask(taskId)
      expect(task!.status).toBe('pending')
    })

    it('resets a cancelled task back to pending', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'cron',
        scheduleExpression: '*/15 * * * *',
        prompt: 'Test',
      })

      await cancelScheduledTask(taskId)

      const result = await resetScheduledTask(taskId)
      expect(result).toBe(true)

      const task = await getScheduledTask(taskId)
      expect(task!.status).toBe('pending')
    })

    it('returns false for nonexistent tasks', async () => {
      const result = await resetScheduledTask('nonexistent-id')
      expect(result).toBe(false)
    })
  })

  // ============================================================================
  // deleteScheduledTask Tests
  // ============================================================================

  describe('deleteScheduledTask', () => {
    it('deletes a task from the database', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 1 hour',
        prompt: 'Test',
      })

      const result = await deleteScheduledTask(taskId)
      expect(result).toBe(true)

      const task = await getScheduledTask(taskId)
      expect(task).toBeNull()
    })

    it('returns false for nonexistent tasks', async () => {
      const result = await deleteScheduledTask('nonexistent-id')
      expect(result).toBe(false)
    })
  })
})
