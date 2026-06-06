/**
 * Regression test for SUP-205 — Paused recurring tasks cannot save edited
 * cron schedules.
 *
 * `updateScheduleExpression()` historically gated on `task.status === 'pending'`,
 * which rejected paused recurring tasks even though the UI exposes "Edit
 * Schedule" for paused tasks (and every sibling mutator allows paused). This
 * test reproduces the bug: a paused cron task must accept a new schedule
 * expression and remain paused.
 */
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
  pauseScheduledTask,
  cancelScheduledTask,
  updateScheduleExpression,
} from './scheduled-task-service'

describe('scheduled-task-service — SUP-205 paused cron schedule edit', () => {
  beforeEach(() => {
    // Create a temp directory for the test database
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-task-sup205-'))

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

  afterEach(() => {
    vi.useRealTimers()
    testSqlite?.close()
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('updates a paused recurring task without resuming it', async () => {
    // (1) Create a recurring cron task.
    const taskId = await createScheduledTask({
      agentSlug: 'test-agent',
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * *',
      prompt: 'Morning report',
    })

    // (2) Pause it.
    const paused = await pauseScheduledTask(taskId)
    expect(paused).toBe(true)
    const afterPause = await getScheduledTask(taskId)
    expect(afterPause!.status).toBe('paused')

    // (3) Edit the cron expression while paused — this is the repro.
    const updated = await updateScheduleExpression(taskId, '0 18 * * *')
    expect(updated).toBe(true)

    // (4) Schedule expression updated, task still paused, nextExecutionAt
    // recomputed to a future date.
    const afterEdit = await getScheduledTask(taskId)
    expect(afterEdit!.scheduleExpression).toBe('0 18 * * *')
    expect(afterEdit!.status).toBe('paused')
    expect(afterEdit!.nextExecutionAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('still updates a pending recurring task (regression guard)', async () => {
    const taskId = await createScheduledTask({
      agentSlug: 'test-agent',
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * *',
      prompt: 'Morning report',
    })

    const updated = await updateScheduleExpression(taskId, '0 18 * * *')
    expect(updated).toBe(true)

    const afterEdit = await getScheduledTask(taskId)
    expect(afterEdit!.scheduleExpression).toBe('0 18 * * *')
    expect(afterEdit!.status).toBe('pending')
  })

  it('rejects schedule edits for cancelled tasks (negative control)', async () => {
    const taskId = await createScheduledTask({
      agentSlug: 'test-agent',
      scheduleType: 'cron',
      scheduleExpression: '0 9 * * *',
      prompt: 'Morning report',
    })

    const cancelled = await cancelScheduledTask(taskId)
    expect(cancelled).toBe(true)

    const updated = await updateScheduleExpression(taskId, '0 18 * * *')
    expect(updated).toBe(false)

    const afterEdit = await getScheduledTask(taskId)
    expect(afterEdit!.scheduleExpression).toBe('0 9 * * *')
    expect(afterEdit!.status).toBe('cancelled')
  })

  it('rejects schedule edits for non-cron (one-time) tasks (negative control)', async () => {
    const taskId = await createScheduledTask({
      agentSlug: 'test-agent',
      scheduleType: 'at',
      scheduleExpression: 'at now + 1 hour',
      prompt: 'One-time task',
    })

    const updated = await updateScheduleExpression(taskId, '0 18 * * *')
    expect(updated).toBe(false)
  })
})
