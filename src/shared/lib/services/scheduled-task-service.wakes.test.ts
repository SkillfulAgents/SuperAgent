import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

// We need to set up a test database before importing the service
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
  cancelPendingWakeForSession,
  createScheduledTask,
  createSessionWake,
  getPendingWakeForSession,
  getScheduledTask,
  listPendingWakesByAgent,
  listPendingScheduledTasks,
  listSessionIdsWithPendingWakes,
  cancelScheduledTask,
  markTaskExecuted,
  getDueTasks,
} from './scheduled-task-service'

describe('scheduled-task-service session wakes', () => {
  beforeEach(async () => {
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })

    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    testSqlite?.close()
  })

  describe('createScheduledTask with resumeSessionId', () => {
    it('persists resumeSessionId when provided', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 1 hour',
        prompt: 'Check for the email reply',
        resumeSessionId: 'session-abc',
      })

      const task = await getScheduledTask(taskId)
      expect(task!.resumeSessionId).toBe('session-abc')
    })

    it('leaves resumeSessionId null for regular tasks', async () => {
      const taskId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 1 hour',
        prompt: 'Regular task',
      })

      const task = await getScheduledTask(taskId)
      expect(task!.resumeSessionId).toBeNull()
    })
  })

  describe('createSessionWake', () => {
    it('creates a pending one-shot wake targeting the session', async () => {
      const { taskId, replaced } = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at tomorrow 9am',
        note: 'Check whether Dana replied to the intro email',
        sessionId: 'session-abc',
        createdByUserId: 'user-1',
      })

      expect(replaced).toBeNull()

      const task = await getScheduledTask(taskId)
      expect(task).not.toBeNull()
      expect(task!.scheduleType).toBe('at')
      expect(task!.isRecurring).toBe(false)
      expect(task!.status).toBe('pending')
      expect(task!.resumeSessionId).toBe('session-abc')
      expect(task!.createdBySessionId).toBe('session-abc')
      expect(task!.createdByUserId).toBe('user-1')
      expect(task!.prompt).toBe('Check whether Dana replied to the intro email')
    })

    it('appears in getDueTasks once its time arrives', async () => {
      await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 30 minutes',
        note: 'Follow up',
        sessionId: 'session-abc',
      })

      expect(await getDueTasks()).toHaveLength(0)

      vi.setSystemTime(new Date('2024-06-15T13:00:00.000Z'))
      const due = await getDueTasks()
      expect(due).toHaveLength(1)
      expect(due[0].resumeSessionId).toBe('session-abc')
    })

    it('replaces an existing pending wake for the same session', async () => {
      const first = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 24 hours',
        note: 'Check tomorrow',
        sessionId: 'session-abc',
      })

      const second = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 72 hours',
        note: 'Actually check in 3 days',
        sessionId: 'session-abc',
      })

      expect(second.replaced).not.toBeNull()
      expect(second.replaced!.id).toBe(first.taskId)

      const oldTask = await getScheduledTask(first.taskId)
      expect(oldTask!.status).toBe('cancelled')

      const newTask = await getScheduledTask(second.taskId)
      expect(newTask!.status).toBe('pending')
      expect(newTask!.prompt).toBe('Actually check in 3 days')
    })

    it('does not replace wakes belonging to other sessions', async () => {
      const other = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 24 hours',
        note: 'Other session wake',
        sessionId: 'session-other',
      })

      const { replaced } = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 24 hours',
        note: 'My wake',
        sessionId: 'session-abc',
      })

      expect(replaced).toBeNull()
      const otherTask = await getScheduledTask(other.taskId)
      expect(otherTask!.status).toBe('pending')
    })

    it('does not replace regular scheduled tasks created by the same session', async () => {
      const regularId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 24 hours',
        prompt: 'Independent job',
        createdBySessionId: 'session-abc',
      })

      const { replaced } = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 24 hours',
        note: 'My wake',
        sessionId: 'session-abc',
      })

      expect(replaced).toBeNull()
      const regular = await getScheduledTask(regularId)
      expect(regular!.status).toBe('pending')
    })

    it('rejects an invalid wakeTime without touching the existing wake', async () => {
      const first = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 24 hours',
        note: 'Valid wake',
        sessionId: 'session-abc',
      })

      await expect(
        createSessionWake({
          agentSlug: 'test-agent',
          scheduleExpression: 'at total gibberish %%%',
          note: 'Broken wake',
          sessionId: 'session-abc',
        })
      ).rejects.toThrow()

      // The valid wake must survive a failed replacement attempt
      const existing = await getScheduledTask(first.taskId)
      expect(existing!.status).toBe('pending')
      expect(await getPendingWakeForSession('test-agent', 'session-abc')).not.toBeNull()
    })

    it('rejects a past wakeTime without touching the existing wake', async () => {
      const first = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 24 hours',
        note: 'Valid wake',
        sessionId: 'session-abc',
      })

      await expect(
        createSessionWake({
          agentSlug: 'test-agent',
          scheduleExpression: 'at 2020-01-01 09:00',
          note: 'Time traveler',
          sessionId: 'session-abc',
        })
      ).rejects.toThrow(/past/)

      const existing = await getScheduledTask(first.taskId)
      expect(existing!.status).toBe('pending')
    })

    it('never leaves more than one pending wake under concurrent creation', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          createSessionWake({
            agentSlug: 'test-agent',
            scheduleExpression: 'at now + 24 hours',
            note: `Concurrent wake ${i}`,
            sessionId: 'session-abc',
          })
        )
      )

      // At least one creation must succeed; a loser rejected by the uniqueness
      // guard is acceptable, silent duplication is not.
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true)

      const pending = await listPendingWakesByAgent('test-agent')
      expect(pending).toHaveLength(1)
    })

    it('does not treat cancelled or executed wakes as replaceable', async () => {
      const first = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 24 hours',
        note: 'Cancelled wake',
        sessionId: 'session-abc',
      })
      await cancelScheduledTask(first.taskId)

      const second = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 24 hours',
        note: 'Executed wake',
        sessionId: 'session-abc',
      })
      await markTaskExecuted(second.taskId, 'session-abc')

      const third = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 24 hours',
        note: 'Fresh wake',
        sessionId: 'session-abc',
      })

      expect(third.replaced).toBeNull()
    })
  })

  describe('getPendingWakeForSession', () => {
    it('returns the pending wake for a session', async () => {
      const { taskId } = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 24 hours',
        note: 'Check tomorrow',
        sessionId: 'session-abc',
      })

      const wake = await getPendingWakeForSession('test-agent', 'session-abc')
      expect(wake).not.toBeNull()
      expect(wake!.id).toBe(taskId)
    })

    it('returns null when the wake was cancelled', async () => {
      const { taskId } = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 24 hours',
        note: 'Check tomorrow',
        sessionId: 'session-abc',
      })
      await cancelScheduledTask(taskId)

      expect(await getPendingWakeForSession('test-agent', 'session-abc')).toBeNull()
    })

    it('returns null for sessions without wakes', async () => {
      expect(await getPendingWakeForSession('test-agent', 'no-such-session')).toBeNull()
    })
  })

  describe('listPendingWakesByAgent', () => {
    it('returns only pending wakes for the given agent', async () => {
      await createSessionWake({
        agentSlug: 'agent-a',
        scheduleExpression: 'at now + 24 hours',
        note: 'Wake A',
        sessionId: 'session-a',
      })
      await createSessionWake({
        agentSlug: 'agent-b',
        scheduleExpression: 'at now + 24 hours',
        note: 'Wake B',
        sessionId: 'session-b',
      })
      // Regular task should not appear
      await createScheduledTask({
        agentSlug: 'agent-a',
        scheduleType: 'at',
        scheduleExpression: 'at now + 24 hours',
        prompt: 'Regular task',
      })

      const wakes = await listPendingWakesByAgent('agent-a')
      expect(wakes).toHaveLength(1)
      expect(wakes[0].resumeSessionId).toBe('session-a')
    })

    it('excludes executed and cancelled wakes', async () => {
      const first = await createSessionWake({
        agentSlug: 'agent-a',
        scheduleExpression: 'at now + 24 hours',
        note: 'Wake 1',
        sessionId: 'session-1',
      })
      await markTaskExecuted(first.taskId, 'session-1')

      const second = await createSessionWake({
        agentSlug: 'agent-a',
        scheduleExpression: 'at now + 24 hours',
        note: 'Wake 2',
        sessionId: 'session-2',
      })
      await cancelScheduledTask(second.taskId)

      expect(await listPendingWakesByAgent('agent-a')).toHaveLength(0)
    })
  })

  describe('listSessionIdsWithPendingWakes', () => {
    it('returns the set of session ids with pending wakes for an agent', async () => {
      await createSessionWake({
        agentSlug: 'agent-a',
        scheduleExpression: 'at now + 24 hours',
        note: 'Wake 1',
        sessionId: 'session-1',
      })
      await createSessionWake({
        agentSlug: 'agent-a',
        scheduleExpression: 'at now + 48 hours',
        note: 'Wake 2',
        sessionId: 'session-2',
      })
      await createSessionWake({
        agentSlug: 'agent-b',
        scheduleExpression: 'at now + 24 hours',
        note: 'Other agent',
        sessionId: 'session-3',
      })

      const ids = await listSessionIdsWithPendingWakes('agent-a')
      expect(ids).toEqual(new Set(['session-1', 'session-2']))
    })

    it('returns an empty set when there are no pending wakes', async () => {
      expect(await listSessionIdsWithPendingWakes('agent-a')).toEqual(new Set())
    })
  })

  describe('cancelPendingWakeForSession', () => {
    it('cancels the pending wake for a session', async () => {
      const { taskId } = await createSessionWake({
        agentSlug: 'test-agent',
        scheduleExpression: 'at now + 24 hours',
        note: 'Check tomorrow',
        sessionId: 'session-abc',
      })

      const cancelled = await cancelPendingWakeForSession('test-agent', 'session-abc')
      expect(cancelled).toBe(true)

      const task = await getScheduledTask(taskId)
      expect(task!.status).toBe('cancelled')
    })

    it('returns false when the session has no pending wake', async () => {
      expect(await cancelPendingWakeForSession('test-agent', 'session-abc')).toBe(false)
    })

    it('leaves regular tasks created by the session untouched', async () => {
      const regularId = await createScheduledTask({
        agentSlug: 'test-agent',
        scheduleType: 'at',
        scheduleExpression: 'at now + 24 hours',
        prompt: 'Independent job',
        createdBySessionId: 'session-abc',
      })

      await cancelPendingWakeForSession('test-agent', 'session-abc')

      const regular = await getScheduledTask(regularId)
      expect(regular!.status).toBe('pending')
    })
  })

  describe('listPendingScheduledTasks interplay', () => {
    it('still includes wakes (callers that need agent-level automations filter them)', async () => {
      await createSessionWake({
        agentSlug: 'agent-a',
        scheduleExpression: 'at now + 24 hours',
        note: 'Wake',
        sessionId: 'session-1',
      })

      const all = await listPendingScheduledTasks('agent-a')
      expect(all).toHaveLength(1)
      expect(all[0].resumeSessionId).toBe('session-1')
    })
  })
})
