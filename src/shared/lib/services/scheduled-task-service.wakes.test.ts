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
  addWakeTarget,
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
  markWakeDueIfSettled,
  resetScheduledTask,
  settleWakeTarget,
  settleWakeTargetsForAgent,
  updateTaskTimezone,
  getDueTasks,
} from './scheduled-task-service'
import { parseWakeOnSessions } from './wake-on-sessions'

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

describe('event wakes (invoked sessions)', () => {
  const idle = () => true
  const busy = () => false

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

  it('addWakeTarget creates an event row with no time, then appends and dedupes', async () => {
    const first = await addWakeTarget({
      agentSlug: 'a', sessionId: 'sess-a',
      target: { agentSlug: 'b', sessionId: 'sess-b', boundaryUuid: 'u-b' },
    })
    const second = await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'c', sessionId: 'sess-c' } })
    const dup = await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'c', sessionId: 'sess-c' } })
    expect(second.taskId).toBe(first.taskId)
    expect(dup.taskId).toBe(first.taskId)
    const task = (await getScheduledTask(first.taskId))!
    expect(task.scheduleType).toBe('event')
    expect(task.nextExecutionAt).toBeNull()
    expect(task.resumeSessionId).toBe('sess-a')
    expect(parseWakeOnSessions(task.wakeOnSessions)!.targets).toEqual([
      { agentSlug: 'b', sessionId: 'sess-b', boundaryUuid: 'u-b' },
      { agentSlug: 'c', sessionId: 'sess-c' },
    ])
    expect(await getDueTasks()).toHaveLength(0)
  })

  it('reopens a stamped target when the same conversation is invoked again', async () => {
    const { taskId } = await addWakeTarget({
      agentSlug: 'a',
      sessionId: 'sess-a',
      target: { agentSlug: 'b', sessionId: 'sess-b', boundaryUuid: 'u-1' },
    })
    await settleWakeTarget({ targetSessionId: 'sess-b', outcome: 'completed', callerIdle: idle })
    expect((await getScheduledTask(taskId))!.nextExecutionAt).toEqual(new Date('2024-06-15T12:00:00.000Z'))

    await addWakeTarget({
      agentSlug: 'a',
      sessionId: 'sess-a',
      target: { agentSlug: 'b', sessionId: 'sess-b', boundaryUuid: 'u-2' },
    })
    const task = (await getScheduledTask(taskId))!
    expect(task.nextExecutionAt).toBeNull()
    expect(parseWakeOnSessions(task.wakeOnSessions)!.targets).toEqual([
      { agentSlug: 'b', sessionId: 'sess-b', boundaryUuid: 'u-2' },
    ])
    expect(await getDueTasks()).toHaveLength(0)
  })

  it('restores a deferred timer when a stamped target is reopened on a due row', async () => {
    const { taskId } = await addWakeTarget({
      agentSlug: 'a',
      sessionId: 'sess-a',
      target: { agentSlug: 'b', sessionId: 'sess-b' },
    })
    await createSessionWake({ agentSlug: 'a', scheduleExpression: 'at now + 2 hours', note: 'later', sessionId: 'sess-a' })
    await settleWakeTarget({ targetSessionId: 'sess-b', outcome: 'completed', callerIdle: idle })
    expect(parseWakeOnSessions((await getScheduledTask(taskId))!.wakeOnSessions)!.deferredTimerAt)
      .toBe('2024-06-15T14:00:00.000Z')

    await addWakeTarget({
      agentSlug: 'a',
      sessionId: 'sess-a',
      target: { agentSlug: 'b', sessionId: 'sess-b', boundaryUuid: 'u-new' },
    })
    const task = (await getScheduledTask(taskId))!
    expect(task.nextExecutionAt).toEqual(new Date('2024-06-15T14:00:00.000Z'))
    expect(parseWakeOnSessions(task.wakeOnSessions)).toEqual({
      targets: [{ agentSlug: 'b', sessionId: 'sess-b', boundaryUuid: 'u-new' }],
    })
  })

  it('settleWakeTarget stamps one target; the row is due only when all are stamped and the caller is idle', async () => {
    const { taskId } = await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b' } })
    await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'c', sessionId: 'sess-c' } })

    expect(await settleWakeTarget({ targetSessionId: 'sess-b', outcome: 'completed', callerIdle: idle })).toEqual([])
    let task = (await getScheduledTask(taskId))!
    expect(task.nextExecutionAt).toBeNull()
    expect(parseWakeOnSessions(task.wakeOnSessions)!.targets.map((t) => t.outcome)).toEqual(['completed', undefined])

    expect(await settleWakeTarget({ targetSessionId: 'sess-c', outcome: 'errored', callerIdle: busy })).toEqual([])
    task = (await getScheduledTask(taskId))!
    expect(task.nextExecutionAt).toBeNull()

    expect(await markWakeDueIfSettled('sess-a')).toBe(true)
    task = (await getScheduledTask(taskId))!
    expect(task.nextExecutionAt).toEqual(new Date('2024-06-15T12:00:00.000Z'))
    expect(await getDueTasks()).toHaveLength(1)
  })

  it('settleWakeTarget makes the row due immediately when the caller is idle', async () => {
    const { taskId } = await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b' } })
    expect(await settleWakeTarget({ targetSessionId: 'sess-b', outcome: 'completed', callerIdle: idle })).toEqual([taskId])
    expect((await getScheduledTask(taskId))!.nextExecutionAt).toEqual(new Date('2024-06-15T12:00:00.000Z'))
  })

  it('settleWakeTarget stamps only unstamped entries (first writer wins)', async () => {
    const { taskId } = await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b' } })
    await settleWakeTarget({ targetSessionId: 'sess-b', outcome: 'errored', callerIdle: busy })
    await settleWakeTarget({ targetSessionId: 'sess-b', outcome: 'deleted', callerIdle: busy })
    expect(parseWakeOnSessions((await getScheduledTask(taskId))!.wakeOnSessions)!.targets[0].outcome).toBe('errored')
  })

  it('settleWakeTarget is a no-op for a session no row is waiting on', async () => {
    expect(await settleWakeTarget({ targetSessionId: 'nobody', outcome: 'completed', callerIdle: idle })).toEqual([])
    expect(await markWakeDueIfSettled('nobody')).toBe(false)
  })

  it('markWakeDueIfSettled is true when the row is already due', async () => {
    const { taskId } = await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b' } })
    await settleWakeTarget({ targetSessionId: 'sess-b', outcome: 'completed', callerIdle: idle })
    expect((await getScheduledTask(taskId))!.nextExecutionAt).toEqual(new Date('2024-06-15T12:00:00.000Z'))
    expect(await markWakeDueIfSettled('sess-a')).toBe(true)
  })

  it('a timer merged onto an event row moves to deferredTimerAt when the targets make it due', async () => {
    const { taskId } = await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b' } })
    const merged = await createSessionWake({ agentSlug: 'a', scheduleExpression: 'at now + 2 hours', note: 'check inbox', sessionId: 'sess-a' })
    expect(merged.taskId).toBe(taskId)
    expect(merged.merged).toBe(true)
    expect(merged.replaced).toBeNull()
    let task = (await getScheduledTask(taskId))!
    expect(task.scheduleType).toBe('at')
    expect(task.prompt).toBe('check inbox')
    expect(task.nextExecutionAt).toEqual(new Date('2024-06-15T14:00:00.000Z'))

    await settleWakeTarget({ targetSessionId: 'sess-b', outcome: 'completed', callerIdle: idle })
    task = (await getScheduledTask(taskId))!
    expect(task.nextExecutionAt).toEqual(new Date('2024-06-15T12:00:00.000Z'))
    expect(parseWakeOnSessions(task.wakeOnSessions)!.deferredTimerAt).toBe('2024-06-15T14:00:00.000Z')
  })

  it('a timer merges onto a row whose targets are all stamped but not yet due (caller was busy)', async () => {
    const { taskId } = await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b' } })
    await settleWakeTarget({ targetSessionId: 'sess-b', outcome: 'completed', callerIdle: busy })
    const merged = await createSessionWake({ agentSlug: 'a', scheduleExpression: 'at now + 2 hours', note: 'later', sessionId: 'sess-a' })
    expect(merged.taskId).toBe(taskId)
    expect(merged.merged).toBe(true)
    // B's outcome survived the merge, and the caller's next idle delivers it
    // with the timer deferred, not the other way round.
    expect(parseWakeOnSessions((await getScheduledTask(taskId))!.wakeOnSessions)!.targets[0].outcome).toBe('completed')
    expect(await markWakeDueIfSettled('sess-a')).toBe(true)
    const task = (await getScheduledTask(taskId))!
    expect(task.nextExecutionAt).toEqual(new Date('2024-06-15T12:00:00.000Z'))
    expect(parseWakeOnSessions(task.wakeOnSessions)!.deferredTimerAt).toBe('2024-06-15T14:00:00.000Z')
  })

  it('settleWakeTargetsForAgent stamps every open target of that agent', async () => {
    const { taskId } = await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b1' } })
    await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b2' } })
    await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'c', sessionId: 'sess-c' } })
    expect(await settleWakeTargetsForAgent({ targetAgentSlug: 'b', outcome: 'deleted', callerIdle: idle })).toEqual([])
    const targets = parseWakeOnSessions((await getScheduledTask(taskId))!.wakeOnSessions)!.targets
    expect(targets.map((t) => t.outcome)).toEqual(['deleted', 'deleted', undefined])
  })

  it('reset and timezone ops refuse an event row', async () => {
    const { taskId } = await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b' } })
    expect(await resetScheduledTask(taskId)).toBe(false)
    expect(await updateTaskTimezone(taskId, 'UTC')).toBe(false)
    expect((await getScheduledTask(taskId))!.nextExecutionAt).toBeNull()
  })

  it('createSessionWake still replaces a pure timer, and a timer row accepts targets', async () => {
    const first = await createSessionWake({ agentSlug: 'a', scheduleExpression: 'at now + 1 hour', note: 'n1', sessionId: 'sess-a' })
    const second = await createSessionWake({ agentSlug: 'a', scheduleExpression: 'at now + 3 hours', note: 'n2', sessionId: 'sess-a' })
    expect(second.replaced!.id).toBe(first.taskId)
    expect(second.merged).toBe(false)

    const added = await addWakeTarget({ agentSlug: 'a', sessionId: 'sess-a', target: { agentSlug: 'b', sessionId: 'sess-b' } })
    expect(added.taskId).toBe(second.taskId)
    const task = (await getScheduledTask(second.taskId))!
    expect(task.scheduleType).toBe('at')
    expect(task.nextExecutionAt).toEqual(new Date('2024-06-15T15:00:00.000Z'))
  })

})

