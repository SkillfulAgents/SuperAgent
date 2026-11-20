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
    migrateDatabase: vi.fn(async () => {}),
    bootIsolate: vi.fn(async () => {}),
    prepareOrg: vi.fn(async (_env?: unknown, _options?: unknown) => {}),
    startBackgroundServices: vi.fn(async () => {}),
    serveInObject: vi.fn(async (request: Request) => new Response(new URL(request.url).pathname)),
    stopBackgroundServices: vi.fn(async () => {}),
    backgroundServicesShutDown: vi.fn(() => false),
    backgroundTasks: () => state.manager,
  }
})
vi.mock('../boot', () => app)
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))
const integrations = vi.hoisted(() => ({ sessionStarted: vi.fn(async (_agentSlug: string, _sessionId: string) => {}) }))
vi.mock('@shared/lib/agent-integrations/agent-integration-manager', () => ({ agentIntegrationManager: integrations }))
const hostTools = vi.hoisted(() => ({ runHostTool: vi.fn() }))
vi.mock('@shared/lib/host/tools', () => ({ runHostTool: hostTools.runHostTool }))
const relay = vi.hoisted(() => ({ available: false }))
vi.mock('@shared/lib/webhook-relay', () => ({ getWebhookRelay: () => ({ snapshot: () => ({ available: relay.available }) }) }))

import { CloudflareTaskManager, DeployStepNotReady, TaskManagerDurableObject, announceSessionStart, runHostToolInTaskManager, servingTaskManager, webhookRelayAvailableInTaskManager, ensureMigrated, ensureOrgPrepared, needsLiveConnections, prepareDeploy, serveInTaskManager } from './cloudflare-task-manager'
import type { Env } from '../index'
import { captureException } from '@shared/lib/error-reporting'

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

function testObject(sql = memorySql(), env = {} as Env) {
  const ctx = {
    id: { name: 'org', toString: () => 'org' },
    // The runs an alarm leaves going; the tests wait for them with `settled`.
    waitUntil: (work: Promise<unknown>) => void work,
    storage: {
      sql,
      getAlarm: async () => object.alarmAt,
      setAlarm: async (at: number) => { object.alarmAt = at },
      deleteAlarm: async () => { object.alarmAt = null },
    },
  }
  const object: TestObject = new TestObject(ctx as unknown as DurableObjectState, env)
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

/** Lets the runs an alarm started go as far as they can: one that waits on the test stays waiting. */
async function settled(): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
  else await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Moves the object's clock and lets its alarm go off. */
async function after(object: TestObject, ms: number): Promise<void> {
  object.clock += ms
  await object.alarm()
  await settled()
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

  it('takes a recurring job\'s new interval from the code of a later deploy', async () => {
    const { object: first, sql } = testObject()
    const earlier = managerFor(first)
    earlier.register(task)
    await earlier.ensureEvery('accounts.sync', spec('sync'), { intervalMs: 60_000 })
    first.stopDispatch()

    // The next deploy syncs every 5 s: the stored job must not keep the minute it was made with.
    const { object: restarted } = testObject(sql)
    const later = managerFor(restarted)
    later.register(task)
    await later.ensureEvery('accounts.sync', spec('sync'), { intervalMs: 5_000 })

    await after(restarted, 5_000)
    expect(task.runs).toHaveLength(1)
    restarted.stopDispatch()
  })

  it('keeps a recurring job\'s next pass when a restarted object is asked for the same job', async () => {
    const { object: first, sql } = testObject()
    const earlier = managerFor(first)
    earlier.register(task)
    await earlier.ensureEvery('accounts.sync', spec('sync'), { intervalMs: 5_000 })
    first.stopDispatch()

    const { object: restarted } = testObject(sql)
    restarted.clock += 3_000
    const later = managerFor(restarted)
    later.register(task)
    await later.ensureEvery('accounts.sync', spec('sync'), { intervalMs: 5_000 })

    // Due 5 s after it was first scheduled, not 5 s after the restart.
    await after(restarted, 2_000)
    expect(task.runs).toHaveLength(1)
    restarted.stopDispatch()
  })

  it('reports a task type this code does not know once, not at every pass', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    await manager.ensureEvery('accounts.sync', spec('sync'), { intervalMs: 1_000 })
    // An older deploy: its isolate never registered the task.
    managerFor(object)

    await after(object, 1_000)
    await after(object, 1_000)
    await after(object, 1_000)

    expect(report).toHaveBeenCalledTimes(1)
  })

  it('skips a recurring pass that comes due while the last one still runs', async () => {
    const gate = deferred()
    task.next = async () => {
      await gate.promise
      return { kind: 'done' }
    }
    await manager.ensureEvery('accounts.sync', spec('sync'), { intervalMs: 1_000 })

    await after(object, 1_000)
    expect(task.runs).toHaveLength(1)
    await after(object, 1_000)
    expect(task.runs).toHaveLength(1)

    gate.resolve()
    await settled()
    await after(object, 1_000)
    expect(task.runs).toHaveLength(2)
  })

  it('answers the alarm while a job still runs, starts another job that comes due meanwhile, and looks again within a minute', async () => {
    const gate = deferred()
    task.next = async (payload) => {
      if (payload.note === 'long import') await gate.promise
      return { kind: 'done' }
    }
    await manager.at(T0, 'import', spec('long import'))
    await manager.at(T0 + 5_000, 'reminder:invoice', spec('Send the March invoice'))

    await after(object, 0)
    expect(task.runs.map((run) => run.note)).toEqual(['long import'])

    await after(object, 5_000)
    expect(task.runs.map((run) => run.note)).toEqual(['long import', 'Send the March invoice'])
    // Nothing else is scheduled, but the long job still runs.
    expect(object.alarmAt).toBe(T0 + 5_000 + 60_000)

    gate.resolve()
    await settled()
    expect(object.alarmAt).toBeNull()
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
    await after(object, 0)
    expect(task.runs).toHaveLength(1)

    await manager.at(T0, 'reminder:invoice', spec('new'))
    await after(object, 0)
    expect(task.runs.map((run) => run.note)).toEqual(['old'])

    gate.resolve()
    await settled()
    await after(object, 0)
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
    await after(object, 0)
    expect(signal).toBeDefined()

    await manager.cancel('reminder:invoice')

    expect(signal!.aborted).toBe(true)
    gate.resolve()
    await settled()
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

  it('keeps a job whose task type this code does not know, and looks at it again later', async () => {
    await manager.at(T0, 'reminder:invoice', spec('Send the March invoice'))
    // An older deploy: its isolate never registered the task.
    const older = managerFor(object)

    await after(object, 0)
    expect(task.runs).toEqual([])
    expect(object.alarmAt).toBe(T0 + 10 * 60_000)

    older.register(task)
    await after(object, 10 * 60_000)
    expect(task.runs.map((run) => run.note)).toEqual(['Send the March invoice'])
  })

  it('takes calls from another isolate in the order they were made', async () => {
    const cancelled = manager.cancel('reminder:invoice')
    const scheduled = manager.at(T0, 'reminder:invoice', spec('kept'))
    await Promise.all([cancelled, scheduled])
    const scheduledAgain = manager.at(T0, 'reminder:old', spec('dropped'))
    const cancelledAgain = manager.cancel('reminder:old')
    await Promise.all([scheduledAgain, cancelledAgain])

    await after(object, 0)
    expect(task.runs.map((run) => run.note)).toEqual(['kept'])
  })

  it('does not hold one job behind a call on another job that never settles', async () => {
    const stuck = manager as unknown as { queues: Map<string, Promise<unknown>> }
    // A call whose request was cancelled midway: its link never settles.
    stuck.queues.set('reminder:stuck', new Promise(() => {}))

    await manager.at(T0, 'reminder:invoice', spec('kept'))

    await after(object, 0)
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

    await object.alarm()
    await object.alarm()

    expect(app.boot).toHaveBeenCalledTimes(1)
    expect(app.startBackgroundServices).toHaveBeenCalledTimes(1)
  })

  it('runs the steps of a deploy that skipped the deploy step before it starts the services, once', async () => {
    for (const mock of [app.migrateDatabase, app.prepareOrg]) mock.mockClear()
    const deploy = { VERSION: { id: 'deploy-2', timestamp: '2026-11-06T12:00:00.000Z' } } as unknown as Env
    const sql = memorySql()

    const { object: skipped } = testObject(sql, deploy)
    managerFor(skipped)
    await skipped.alarm()
    expect(app.migrateDatabase).toHaveBeenCalledTimes(1)
    expect(app.prepareOrg).toHaveBeenCalledExactlyOnceWith(deploy, { seed: true, origin: undefined })
    expect(app.prepareOrg.mock.invocationCallOrder[0]).toBeLessThan(app.startBackgroundServices.mock.invocationCallOrder[0])
    skipped.stopDispatch()

    // The object restarted on the same deploy: the steps are done.
    const { object: restarted } = testObject(sql, deploy)
    managerFor(restarted)
    await restarted.alarm()
    expect(app.migrateDatabase).toHaveBeenCalledTimes(1)
    expect(app.prepareOrg).toHaveBeenCalledTimes(1)
    restarted.stopDispatch()
  })

  it('does not start the services while a step of the deploy fails, and tries again at the next alarm', async () => {
    app.migrateDatabase.mockClear()
    app.migrateDatabase.mockRejectedValueOnce(new Error('D1 is unavailable'))
    const { object } = testObject(memorySql(), { VERSION: { id: 'deploy-2', timestamp: '2026-11-06T12:00:00.000Z' } } as unknown as Env)
    managerFor(object)

    await expect(object.alarm()).rejects.toThrow('D1 is unavailable')
    expect(app.startBackgroundServices).not.toHaveBeenCalled()

    await object.alarm()
    expect(app.startBackgroundServices).toHaveBeenCalledTimes(1)
    object.stopDispatch()
  })

  it('stops its services and runs nothing more once a newer instance replaced it', async () => {
    const { object, sql } = testObject()
    const manager = managerFor(object)
    const task = new RecordingTask()
    manager.register(task)
    await object.alarm()
    await manager.at(T0 + 60_000, 'reminder:invoice', spec('Send the March invoice'))

    sql.refuse = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(app.stopBackgroundServices).toHaveBeenCalledTimes(1)

    sql.refuse = false
    await after(object, 60_000)
    expect(task.runs).toEqual([])
  })

  it('starts over instead of running without services when a replaced instance shut them down in its isolate', async () => {
    const { object } = testObject()
    managerFor(object)
    const abort = vi.fn((reason: string) => {
      throw new Error(reason)
    })
    Object.assign((object as unknown as { ctx: object }).ctx, { abort })
    app.backgroundServicesShutDown.mockReturnValueOnce(true)

    await expect(object.alarm()).rejects.toThrow('shut down by a replaced instance')
    expect(abort).toHaveBeenCalledOnce()
    expect(app.startBackgroundServices).not.toHaveBeenCalled()
  })

  it("lets the rest of the isolate go on scheduling after a replaced instance stopped its services", async () => {
    const { object: replaced, sql } = testObject()
    const { object: live } = testObject()
    // One isolate's manager: the replaced instance's services stop through it, as shutdownServices does.
    const manager = new CloudflareTaskManager({ getByName: () => live } as unknown as DurableObjectNamespace<TaskManagerDurableObject>)
    app.state.manager = manager
    const task = new RecordingTask()
    manager.register(task)
    app.stopBackgroundServices.mockImplementationOnce(() => manager.stop())
    await replaced.alarm()

    sql.refuse = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(app.stopBackgroundServices).toHaveBeenCalledTimes(1)

    // Another object of the org in the same isolate schedules a job: it reaches the live instance.
    await manager.at(T0, 'reminder:invoice', spec('Send the March invoice'))
    await after(live, 0)
    expect(task.runs.map((run) => run.note)).toEqual(['Send the March invoice'])
    live.stopDispatch()
  })
})

describe('a session that starts a turn', () => {
  it("is announced to the integration manager in the task manager object, with its services started", async () => {
    integrations.sessionStarted.mockClear()
    app.startBackgroundServices.mockClear()
    const { object } = testObject()
    managerFor(object)
    const objects = { getByName: () => object } as unknown as DurableObjectNamespace<TaskManagerDurableObject>

    await announceSessionStart({ TASK_MANAGER: objects }, 'sales', 'session-1')

    expect(app.startBackgroundServices).toHaveBeenCalledTimes(1)
    expect(integrations.sessionStarted).toHaveBeenCalledExactlyOnceWith('sales', 'session-1')
    object.stopDispatch()
  })

  it('does not fail the turn when the task manager object cannot be reached', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const unreachable = { getByName: () => ({ sessionStarted: async () => { throw new Error('Network connection lost.') } }) } as unknown as DurableObjectNamespace<TaskManagerDurableObject>

    await expect(announceSessionStart({ TASK_MANAGER: unreachable }, 'sales', 'session-1')).resolves.toBeUndefined()
    expect(captureException).toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe("an agent session's host tools", () => {
  const request = { agentSlug: 'sales', sessionId: 'session-1', toolUseId: 'tool-1', toolName: 'create_webhook_endpoint' as const, input: '{"name":"Orders"}' }

  it('run in the task manager object, after its services started', async () => {
    app.startBackgroundServices.mockClear()
    hostTools.runHostTool.mockReset()
    const { object } = testObject()
    managerFor(object)
    const objects = { getByName: () => object } as unknown as DurableObjectNamespace<TaskManagerDurableObject>
    let servedBy: unknown
    hostTools.runHostTool.mockImplementationOnce(async () => {
      servedBy = servingTaskManager()
      return { status: 'resolved', value: 'Created the endpoint' }
    })

    expect(await runHostToolInTaskManager({ TASK_MANAGER: objects }, request)).toEqual({ status: 'resolved', value: 'Created the endpoint' })

    expect(hostTools.runHostTool).toHaveBeenCalledExactlyOnceWith(request)
    expect(servedBy).toBe(object)
    expect(app.startBackgroundServices.mock.invocationCallOrder[0]).toBeLessThan(hostTools.runHostTool.mock.invocationCallOrder[0])
    object.stopDispatch()
  })

  it('reject when the task manager object cannot be reached, so the session reports the tool as failed', async () => {
    const unreachable = { getByName: () => ({ runHostTool: async () => { throw new Error('Network connection lost.') } }) } as unknown as DurableObjectNamespace<TaskManagerDurableObject>

    await expect(runHostToolInTaskManager({ TASK_MANAGER: unreachable }, request)).rejects.toThrow('Network connection lost.')
  })
})

describe("the webhook relay's status for an agent's container start", () => {
  it('is read from the relay in the task manager object, after its services started', async () => {
    app.startBackgroundServices.mockClear()
    const { object } = testObject()
    managerFor(object)
    const objects = { getByName: () => object } as unknown as DurableObjectNamespace<TaskManagerDurableObject>

    relay.available = true
    expect(await webhookRelayAvailableInTaskManager({ TASK_MANAGER: objects })).toBe(true)
    relay.available = false
    expect(await webhookRelayAvailableInTaskManager({ TASK_MANAGER: objects })).toBe(false)

    expect(app.startBackgroundServices).toHaveBeenCalledTimes(1)
    object.stopDispatch()
  })
})

describe('requests that need the live chat connections', () => {
  it('names the routes that read or change a connection, and no other', () => {
    for (const path of [
      '/api/agent-integrations',
      '/api/agent-integrations/int_1/pause',
      '/api/chat-integrations/int_1',
      '/api/agents/support-desk/chat-integrations',
      '/api/home-graph',
      '/api/webhook-relay',
      '/api/x-agent/chat/send',
      '/api/x-agent/meetings/join',
      '/api/agents/support-desk/sessions/session-1/fill-login',
      '/api/agents/support-desk/sessions/session-1/login-via',
    ]) expect(needsLiveConnections(path), path).toBe(true)
    for (const path of [
      '/api/agents',
      '/api/agents/support-desk/sessions',
      '/api/agents/support-desk/sessions/session-1/login-request',
      '/api/agents/support-desk/sessions/session-1/fill-login/extra',
      '/api/agent-integrations-export',
      '/api/x-agent/chatter',
      '/api/x-agent/integrations',
      '/api/x-agent/sessions',
    ]) expect(needsLiveConnections(path), path).toBe(false)
  })

  it('serves the request in the task manager object, with its services started first', async () => {
    for (const mock of [app.boot, app.startBackgroundServices, app.serveInObject]) mock.mockClear()
    const { object } = testObject()
    const objects = { getByName: () => object } as unknown as DurableObjectNamespace<TaskManagerDurableObject>

    const response = await serveInTaskManager(new Request('https://acme.example/api/agent-integrations/int_1/pause', { method: 'POST' }), { TASK_MANAGER: objects })

    expect(await response.text()).toBe('/api/agent-integrations/int_1/pause')
    expect(app.startBackgroundServices).toHaveBeenCalledTimes(1)
    expect(app.startBackgroundServices.mock.invocationCallOrder[0]).toBeLessThan(app.serveInObject.mock.invocationCallOrder[0])
    object.stopDispatch()
  })
})

describe('migrating the database', () => {
  const deploy = (id: string) => ({ VERSION: { id, timestamp: '2026-11-06T12:00:00.000Z' } }) as unknown as Env

  beforeEach(() => {
    app.migrateDatabase.mockReset()
    app.migrateDatabase.mockResolvedValue(undefined)
  })

  it('migrates once per deploy, however many isolates ask and however often the object restarts', async () => {
    const sql = memorySql()
    const { object } = testObject(sql, deploy('deploy-1'))
    const objects = { getByName: () => object } as unknown as DurableObjectNamespace<TaskManagerDurableObject>

    await Promise.all([ensureMigrated({ TASK_MANAGER: objects }), ensureMigrated({ TASK_MANAGER: objects })])
    expect(app.migrateDatabase).toHaveBeenCalledTimes(1)

    // The object restarted on the same deploy: its storage remembers.
    await testObject(sql, deploy('deploy-1')).object.migrate()
    expect(app.migrateDatabase).toHaveBeenCalledTimes(1)

    await testObject(sql, deploy('deploy-2')).object.migrate()
    expect(app.migrateDatabase).toHaveBeenCalledTimes(2)
  })

  it('tries a failed migration again on the next call', async () => {
    const { object } = testObject(memorySql(), deploy('deploy-1'))
    app.migrateDatabase.mockRejectedValueOnce(new Error('D1 is unavailable'))

    await expect(object.migrate()).rejects.toThrow('D1 is unavailable')
    await object.migrate()
    await object.migrate()
    expect(app.migrateDatabase).toHaveBeenCalledTimes(2)
  })

  it('runs the org setup once per deploy, after a boot that does not wait for it', async () => {
    app.prepareOrg.mockClear()
    app.bootIsolate.mockClear()
    const sql = memorySql()
    const { object } = testObject(sql, deploy('deploy-1'))
    const objects = { getByName: () => object } as unknown as DurableObjectNamespace<TaskManagerDurableObject>

    await Promise.all([ensureOrgPrepared({ TASK_MANAGER: objects }), ensureOrgPrepared({ TASK_MANAGER: objects })])
    await testObject(sql, deploy('deploy-1')).object.prepareOrg()
    expect(app.prepareOrg).toHaveBeenCalledTimes(1)
    expect(app.bootIsolate.mock.invocationCallOrder[0]).toBeLessThan(app.prepareOrg.mock.invocationCallOrder[0])
    // The migration is its own step: one being done does not count for the other.
    expect(app.migrateDatabase).not.toHaveBeenCalled()

    await testObject(sql, deploy('deploy-2')).object.prepareOrg()
    expect(app.prepareOrg).toHaveBeenCalledTimes(2)
  })

  it('applies the seed settings in one deploy only, and uses the deployment\'s own origin when it names one', async () => {
    app.prepareOrg.mockClear()
    const sql = memorySql()
    const env = (id: string) => ({ ...deploy(id), SEED_SETTINGS: '{"app":{"allowSignups":true}}', APP_ORIGIN: 'https://agents.example.com' }) as unknown as Env

    await testObject(sql, env('deploy-1')).object.prepareOrg(undefined, 'https://superagent.acme.workers.dev')
    await testObject(sql, env('deploy-2')).object.prepareOrg()

    expect(app.prepareOrg.mock.calls.map(([, options]) => options)).toEqual([
      { seed: true, origin: 'https://agents.example.com' },
      { seed: false, origin: 'https://agents.example.com' },
    ])
  })

  it("does not run a deploy's step in an object that still runs the previous deploy's code", async () => {
    app.prepareOrg.mockClear()
    const sql = memorySql()
    const previous = { id: 'deploy-1', timestamp: '2026-11-06T12:00:00.000Z' }
    const uploaded = { id: 'deploy-2', timestamp: '2026-11-06T12:05:00.000Z' }
    // The previous deploy ran its own steps.
    const before = testObject(sql, { VERSION: previous } as unknown as Env).object
    await before.migrate()
    await before.prepareOrg()
    app.migrateDatabase.mockClear()
    app.prepareOrg.mockClear()

    // After the upload the Worker runs the new code, and the object still the previous one.
    const old = testObject(sql, { VERSION: previous } as unknown as Env)
    const restart = vi.fn()
    Object.assign((old.object as unknown as { ctx: object }).ctx, { abort: restart })
    const stale = { getByName: () => old.object } as unknown as DurableObjectNamespace<TaskManagerDurableObject>
    await expect(prepareDeploy({ TASK_MANAGER: stale, VERSION: uploaded })).rejects.toBeInstanceOf(DeployStepNotReady)
    expect(app.migrateDatabase).not.toHaveBeenCalled()
    expect(app.prepareOrg).not.toHaveBeenCalled()
    // It restarts, so a later call reaches the uploaded code.
    await vi.waitFor(() => expect(restart).toHaveBeenCalled())

    // Once the object runs the uploaded code, the same call runs both steps.
    const current = testObject(sql, { VERSION: uploaded } as unknown as Env)
    const fresh = { getByName: () => current.object } as unknown as DurableObjectNamespace<TaskManagerDurableObject>
    await prepareDeploy({ TASK_MANAGER: fresh, VERSION: uploaded })
    expect(app.migrateDatabase).toHaveBeenCalledTimes(1)
    expect(app.prepareOrg).toHaveBeenCalledTimes(1)
  })

  it('leaves nothing for a boot to run once the deploy step ran', async () => {
    app.prepareOrg.mockClear()
    const { object } = testObject(memorySql(), deploy('deploy-1'))
    const objects = { getByName: () => object } as unknown as DurableObjectNamespace<TaskManagerDurableObject>

    await prepareDeploy({ TASK_MANAGER: objects })
    expect(app.migrateDatabase).toHaveBeenCalledTimes(1)
    expect(app.prepareOrg).toHaveBeenCalledTimes(1)
    expect(app.migrateDatabase.mock.invocationCallOrder[0]).toBeLessThan(app.prepareOrg.mock.invocationCallOrder[0])

    await Promise.all([ensureMigrated({ TASK_MANAGER: objects }), ensureOrgPrepared({ TASK_MANAGER: objects })])
    expect(app.migrateDatabase).toHaveBeenCalledTimes(1)
    expect(app.prepareOrg).toHaveBeenCalledTimes(1)
  })
})
