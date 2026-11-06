import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { z } from 'zod'
import type { DurableObjectNamespace, DurableObjectState, SqlStorage, SqlStorageValue } from 'cloudflare:workers'
import { Task, type TaskContext, type TaskResult } from '@shared/lib/background-work'

const app = vi.hoisted(() => {
  const state = { manager: null as unknown }
  return {
    state,
    boot: vi.fn(async () => {}),
    startBackgroundServices: vi.fn(async () => {}),
    stopBackgroundServices: vi.fn(async () => {}),
    backgroundTasks: () => state.manager,
  }
})
vi.mock('./boot', () => app)
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import { TaskManagerDurableObject } from './task-manager-durable-object'
import { CloudflareTaskManager } from './cloudflare-task-manager'
import type { Env } from './index'

const T0 = Date.UTC(2026, 10, 6, 12)

/** A Durable Object's `ctx.storage.sql` over an in-memory SQLite database; `refuse` makes it act replaced. */
function memorySql(): SqlStorage & { refuse: boolean } {
  const db = new Database(':memory:')
  const sql = {
    refuse: false,
    exec(query: string, ...bindings: SqlStorageValue[]) {
      if (sql.refuse) throw new Error('Durable Object reset because its code was updated.')
      const statement = db.prepare(query)
      let rows: unknown[] = []
      if (statement.reader) rows = statement.all(...bindings)
      else statement.run(...bindings)
      return { toArray: () => rows, one: () => rows[0] }
    },
  }
  return sql as unknown as SqlStorage & { refuse: boolean }
}

/** The task manager object, whose clock and alarm the test drives. */
class TestObject extends TaskManagerDurableObject {
  clock = T0
  alarmAt: number | null = null

  protected override now(): number {
    return this.clock
  }
}

function testObject(sql = memorySql()) {
  const ctx = {
    id: { name: 'org', toString: () => 'org' },
    storage: {
      sql,
      getAlarm: async () => object.alarmAt,
      setAlarm: async (at: number) => { object.alarmAt = at },
      deleteAlarm: async () => { object.alarmAt = null },
    },
  }
  const object: TestObject = new TestObject(ctx as unknown as DurableObjectState, {} as Env)
  return { object, sql }
}

/** The org's isolates reach the object through its stub: here, the object itself. */
function managerFor(object: TaskManagerDurableObject): CloudflareTaskManager {
  const manager = new CloudflareTaskManager({ getByName: () => object } as unknown as DurableObjectNamespace<TaskManagerDurableObject>)
  app.state.manager = manager
  return manager
}

const payloadSchema = z.object({ note: z.string() })
type Payload = z.infer<typeof payloadSchema>

/** A task that records each run and does what the test tells it. */
class RecordingTask extends Task<Payload> {
  readonly type = 'test.record'
  readonly payloadSchema = payloadSchema
  readonly runs: Array<{ note: string; ctx: TaskContext }> = []
  next: (payload: Payload, ctx: TaskContext) => Promise<TaskResult<Payload>> = async () => ({ kind: 'done' })

  constructor(readonly retryPolicy?: { delaysMs: number[] }) {
    super()
  }

  async execute(payload: Payload, ctx: TaskContext): Promise<TaskResult<Payload>> {
    this.runs.push({ note: payload.note, ctx })
    return this.next(payload, ctx)
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** Moves the object's clock and lets its alarm go off. */
async function after(object: TestObject, ms: number): Promise<void> {
  object.clock += ms
  await object.alarm()
}

const spec = (note: string) => ({ taskType: 'test.record', payload: { note } })

describe('TaskManagerDurableObject', () => {
  let object: TestObject
  let manager: CloudflareTaskManager
  let task: RecordingTask

  beforeEach(() => {
    ;({ object } = testObject())
    manager = managerFor(object)
    task = new RecordingTask({ delaysMs: [500] })
    manager.register(task)
  })

  afterEach(() => {
    object.stopDispatch()
    vi.restoreAllMocks()
  })

  it('runs a one-off once, when it comes due, and arms the alarm for it', async () => {
    await manager.at(T0 + 1_000, 'reminder:invoice', spec('Send the March invoice'))
    expect(object.alarmAt).toBe(T0 + 1_000)

    await after(object, 999)
    expect(task.runs).toEqual([])

    await after(object, 1)
    await after(object, 10_000)
    expect(task.runs.map((run) => run.note)).toEqual(['Send the March invoice'])
    expect(object.alarmAt).toBeNull()
  })

  it('replaces a job scheduled under the same id, and leaves a recurring job as it is', async () => {
    await manager.at(T0 + 1_000, 'reminder:invoice', spec('first'))
    await manager.at(T0 + 2_000, 'reminder:invoice', spec('second'))
    await manager.ensureEvery('accounts.sync', spec('sync'), { intervalMs: 5_000 })
    await manager.ensureEvery('accounts.sync', spec('ignored'), { intervalMs: 1_000 })

    await after(object, 2_000)
    await after(object, 3_000)
    expect(task.runs.map((run) => run.note)).toEqual(['second', 'sync'])
  })

  it('skips a recurring pass that comes due while the last one still runs', async () => {
    const gate = deferred()
    task.next = async () => {
      await gate.promise
      return { kind: 'done' }
    }
    await manager.ensureEvery('accounts.sync', spec('sync'), { intervalMs: 1_000 })

    object.clock += 1_000
    const first = object.alarm()
    await vi.waitFor(() => expect(task.runs).toHaveLength(1))
    await after(object, 1_000)
    expect(task.runs).toHaveLength(1)

    gate.resolve()
    await first
    await after(object, 1_000)
    expect(task.runs).toHaveLength(2)
  })

  it("retries a failed occurrence by the task's policy, keeping its execution id", async () => {
    task.next = async (_payload, ctx) => {
      if (ctx.attempt === 1) throw new Error('mail server busy')
      return { kind: 'done' }
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await manager.at(T0, 'reminder:invoice', spec('Send the March invoice'))

    await after(object, 0)
    await after(object, 500)

    expect(task.runs.map((run) => run.ctx.attempt)).toEqual([1, 2])
    expect(task.runs[1].ctx.executionId).toBe(task.runs[0].ctx.executionId)
  })

  it('schedules the next occurrence with its new payload, as a new execution', async () => {
    task.next = async (payload) => (payload.note === 'Monday digest' ? { kind: 'next', at: T0 + 7_000, payload: { note: 'Next Monday digest' } } : { kind: 'done' })
    await manager.at(T0, 'digest', spec('Monday digest'))

    await after(object, 0)
    await after(object, 7_000)

    expect(task.runs.map((run) => run.note)).toEqual(['Monday digest', 'Next Monday digest'])
    expect(task.runs[1].ctx.executionId).not.toBe(task.runs[0].ctx.executionId)
  })

  it('ignores the result of a run replaced while it ran, and runs the replacement after it', async () => {
    const gate = deferred()
    task.next = async (payload) => {
      if (payload.note === 'old') {
        await gate.promise
        return { kind: 'retry', at: T0 }
      }
      return { kind: 'done' }
    }
    await manager.at(T0, 'reminder:invoice', spec('old'))
    const first = object.alarm()
    await vi.waitFor(() => expect(task.runs).toHaveLength(1))

    await manager.at(T0, 'reminder:invoice', spec('new'))
    await object.alarm()
    expect(task.runs.map((run) => run.note)).toEqual(['old'])

    gate.resolve()
    await first
    await object.alarm()
    expect(task.runs.map((run) => run.note)).toEqual(['old', 'new'])
  })

  it('aborts a run when its job is cancelled', async () => {
    let signal: AbortSignal | undefined
    const gate = deferred()
    task.next = async (_payload, ctx) => {
      signal = ctx.signal
      await gate.promise
      return { kind: 'done' }
    }
    await manager.at(T0, 'reminder:invoice', spec('Send the March invoice'))
    const run = object.alarm()
    await vi.waitFor(() => expect(signal).toBeDefined())

    await manager.cancel('reminder:invoice')

    expect(signal!.aborted).toBe(true)
    gate.resolve()
    await run
  })

  it('keeps the schedule for a new instance of the object', async () => {
    const { object: first, sql } = testObject()
    const scheduler = managerFor(first)
    scheduler.register(task)
    await scheduler.at(T0 + 1_000, 'reminder:invoice', spec('Send the March invoice'))

    const { object: restarted } = testObject(sql)
    managerFor(restarted).register(task)
    await after(restarted, 1_000)

    expect(task.runs.map((run) => run.note)).toEqual(['Send the March invoice'])
  })

  it('takes calls from another isolate in the order they were made', async () => {
    const cancelled = manager.cancel('reminder:invoice')
    const scheduled = manager.at(T0, 'reminder:invoice', spec('kept'))
    await Promise.all([cancelled, scheduled])
    const scheduledAgain = manager.at(T0, 'reminder:old', spec('dropped'))
    const cancelledAgain = manager.cancel('reminder:old')
    await Promise.all([scheduledAgain, cancelledAgain])

    await object.alarm()
    expect(task.runs.map((run) => run.note)).toEqual(['kept'])
  })

  it('refuses a payload its schema rejects, before it reaches the object', async () => {
    await expect(manager.at(T0, 'reminder:invoice', { taskType: 'test.record', payload: { note: 7 } as unknown as Payload })).rejects.toThrow()
    await object.alarm()
    expect(task.runs).toEqual([])
  })
})

describe('TaskManagerDurableObject after a deploy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const mock of [app.boot, app.startBackgroundServices, app.stopBackgroundServices]) mock.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('starts the background services once', async () => {
    const { object } = testObject()
    managerFor(object)

    await object.wake()
    await object.alarm()

    expect(app.boot).toHaveBeenCalledTimes(1)
    expect(app.startBackgroundServices).toHaveBeenCalledTimes(1)
  })

  it('stops its services and runs nothing more once a newer instance replaced it', async () => {
    const { object, sql } = testObject()
    const manager = managerFor(object)
    const task = new RecordingTask()
    manager.register(task)
    await object.wake()
    await manager.at(T0 + 60_000, 'reminder:invoice', spec('Send the March invoice'))

    sql.refuse = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(app.stopBackgroundServices).toHaveBeenCalledTimes(1)

    sql.refuse = false
    await after(object, 60_000)
    expect(task.runs).toEqual([])
  })
})
