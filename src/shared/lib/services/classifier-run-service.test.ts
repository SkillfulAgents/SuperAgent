import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../db/schema'

let testDir: string
let testDb: ReturnType<typeof drizzle>
let testSqlite: InstanceType<typeof Database>

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

import {
  createClassifierRun,
  getClassifierRunByFire,
  getOpenClassifierRuns,
  markClassifierRunResolved,
  setClassifySessionId,
  storeClassifierVerdict,
} from './classifier-run-service'

describe('classifier-run-service', () => {
  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'classifier-run-test-'))
    testSqlite = new Database(':memory:')
    testDb = drizzle(testSqlite, { schema })
    const migrationsFolder = path.join(process.cwd(), 'src/shared/lib/db/migrations')
    migrate(testDb, { migrationsFolder })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
  })

  afterEach(async () => {
    vi.useRealTimers()
    testSqlite?.close()
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('creates a unique fire record and returns existing on re-claim', async () => {
    const fireAt = new Date('2026-07-22T12:00:00.000Z')
    const first = await createClassifierRun({
      scheduledTaskId: 'task-1',
      agentSlug: 'agent-one',
      fireAt,
    })
    const second = await createClassifierRun({
      scheduledTaskId: 'task-1',
      agentSlug: 'agent-one',
      fireAt,
    })
    expect(second.id).toBe(first.id)
    expect(await getClassifierRunByFire('task-1', fireAt)).toEqual(first)
  })

  it('lists only open runs and resolves them', async () => {
    const fireAt = new Date('2026-07-22T12:00:00.000Z')
    const run = await createClassifierRun({
      scheduledTaskId: 'task-1',
      agentSlug: 'agent-one',
      fireAt,
    })
    await setClassifySessionId(run.id, 'sess-1')
    await storeClassifierVerdict(run.id, 'escalate', 'needs work')
    expect((await getOpenClassifierRuns()).map((r) => r.id)).toEqual([run.id])

    const closed = await markClassifierRunResolved(run.id, {
      verdict: 'escalate',
      reason: 'needs work',
      escalateSessionId: 'sess-esc',
    })
    expect(closed).toBe(true)
    expect(await getOpenClassifierRuns()).toEqual([])
  })
})
