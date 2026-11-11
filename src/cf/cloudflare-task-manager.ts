/**
 * The TaskManager on Cloudflare: the CFTaskManager of docs/background-work.md.
 *
 * CloudflareTaskManager is the TaskManager of every isolate of the org. Handlers are registered
 * there, as on LocalTaskManager, and payloads are checked the same way. `at`, `ensureEvery` and
 * `cancel` go to the org's TaskManagerDurableObject (cloudflare-task-manager-object.ts), in the
 * order they are called. That object is only a type here: it boots the background services, which
 * an isolate that schedules work need not load.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { DurableObjectNamespace } from 'cloudflare:workers'
import type { Env } from './index'
import type { TaskManagerDurableObject } from './cloudflare-task-manager-object'
import { reachCurrentCode } from './object-version'
import { Task, TaskManager, type PeriodicOptions, type RetryPolicy, type TaskContext, type TaskSpec } from '@shared/lib/background-work'
import { captureException } from '@shared/lib/error-reporting'

/** The name of the org's one task manager object. */
const OBJECT_NAME = 'org'

/** What CloudflareTaskManager.execute hands back for the object to apply. */
export type ExecutionOutcome =
  | { kind: 'done' }
  | { kind: 'retry'; at: number }
  | { kind: 'next'; at: number; payloadJson: string }
  /** `retryInMs` is set when the task's retry policy allows another attempt. */
  | { kind: 'failed'; error: unknown; retryInMs?: number }

export interface Periodic {
  intervalMs: number
  initialDelayMs?: number
  jitterRatio?: number
}


const serving = new AsyncLocalStorage<TaskManagerDurableObject>()

/** The org's task manager object when it is the one serving the current request; null otherwise. */
export function servingTaskManager(): TaskManagerDurableObject | null {
  return serving.getStore() ?? null
}

/** Runs `work` as the org's task manager object: what it schedules there goes to the object directly. */
export function runAsTaskManager<T>(object: TaskManagerDurableObject, work: () => T): T {
  return serving.run(object, work)
}

/** Makes sure the org's task manager runs its services, once it runs this deploy's code or newer. */
export async function startTaskManager(env: Pick<Env, 'TASK_MANAGER' | 'VERSION'>): Promise<void> {
  await reachCurrentCode(env.TASK_MANAGER, OBJECT_NAME, env.VERSION?.timestamp)
  await env.TASK_MANAGER.getByName(OBJECT_NAME).wake()
}

/**
 * Resolves once the org's database is at this deploy's schema and data. The task manager object
 * migrates it once per deploy; every isolate waits here before it opens the database.
 */
export async function ensureMigrated(env: Pick<Env, 'TASK_MANAGER' | 'VERSION'>): Promise<void> {
  // The object's own boot: a call through its stub would come back to it.
  const own = servingTaskManager()
  if (own) return own.migrate()
  await reachCurrentCode(env.TASK_MANAGER, OBJECT_NAME, env.VERSION?.timestamp)
  await env.TASK_MANAGER.getByName(OBJECT_NAME).migrate()
}

/**
 * Resolves once the org's once-per-deploy setup has run (prepareOrg in boot.ts). Every isolate
 * waits here at the end of its boot instead of running that setup itself.
 */
export async function ensureOrgPrepared(env: Pick<Env, 'TASK_MANAGER' | 'VERSION'>): Promise<void> {
  const own = servingTaskManager()
  if (own) return own.prepareOrg()
  await reachCurrentCode(env.TASK_MANAGER, OBJECT_NAME, env.VERSION?.timestamp)
  await env.TASK_MANAGER.getByName(OBJECT_NAME).prepareOrg()
}

type Schedule = Pick<TaskManagerDurableObject, 'scheduleAt' | 'scheduleEvery' | 'cancelJob' | 'stopDispatch'>

function retryDelay(policy: RetryPolicy, attempt: number): number | undefined {
  if (policy.delaysMs.length === 0) return undefined
  if (attempt >= (policy.maxAttempts ?? policy.delaysMs.length + 1)) return undefined
  return policy.delaysMs[Math.min(attempt - 1, policy.delaysMs.length - 1)]
}

export class CloudflareTaskManager extends TaskManager {
  private readonly handlers = new Map<string, Task<unknown>>()
  // Calls take effect in the order they are made, as docs/background-work.md asks of every backend.
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(
    private readonly objects: DurableObjectNamespace<TaskManagerDurableObject>,
    private readonly version?: string,
  ) {
    super()
  }

  register<P>(task: Task<P>): void {
    this.handlers.set(task.type, task as Task<unknown>)
  }

  handles(taskType: string): boolean {
    return this.handlers.has(taskType)
  }

  async at<P>(runAt: number, id: string, spec: TaskSpec<P>): Promise<void> {
    const payloadJson = this.checkedPayloadJson(spec.taskType, spec.payload)
    if (!Number.isFinite(runAt)) throw new Error(`Task ${spec.taskType} (${id}) was scheduled at an invalid time`)
    if (this.stopped) return
    await this.inOrder((schedule) => schedule.scheduleAt(id, spec.taskType, payloadJson, runAt))
  }

  async ensureEvery<P>(id: string, spec: TaskSpec<P>, options: PeriodicOptions): Promise<void> {
    const payloadJson = this.checkedPayloadJson(spec.taskType, spec.payload)
    if (!(options.intervalMs > 0)) throw new Error(`Task ${spec.taskType} (${id}) was scheduled with an invalid interval`)
    if (this.stopped) return
    await this.inOrder((schedule) => schedule.scheduleEvery(id, spec.taskType, payloadJson, { intervalMs: options.intervalMs, initialDelayMs: options.initialDelayMs, jitterRatio: options.jitterRatio }))
  }

  async cancel(id: string): Promise<void> {
    await this.inOrder((schedule) => schedule.cancelJob(id))
  }

  /** Dispatch is the object's alarm; an isolate has nothing to start. */
  async start(): Promise<void> {
    this.stopped = false
  }

  /**
   * Nothing is scheduled from this isolate after this. In the object, dispatch stops too, and
   * the jobs stay stored for the next instance: stopping is not cancelling.
   */
  async stop(): Promise<void> {
    this.stopped = true
    await servingTaskManager()?.stopDispatch()
  }

  /** One run of a job, in the object's isolate: the handler, then what the object should do next. */
  async execute(taskType: string, payloadJson: string, ctx: TaskContext): Promise<ExecutionOutcome> {
    const task = this.handler(taskType)
    let result
    try {
      result = await task.execute(task.payloadSchema.parse(JSON.parse(payloadJson)), ctx)
    } catch (error) {
      return { kind: 'failed', error, retryInMs: task.retryPolicy ? retryDelay(task.retryPolicy, ctx.attempt) : undefined }
    }
    if (result.kind !== 'next') return result
    try {
      if (!Number.isFinite(result.at)) throw new Error(`Task ${taskType} (${ctx.jobId}) returned an invalid time`)
      return { kind: 'next', at: result.at, payloadJson: this.checkedPayloadJson(taskType, result.payload) }
    } catch (error) {
      return { kind: 'failed', error }
    }
  }

  report(error: unknown, { taskType, jobId, attempt }: { taskType: string; jobId: string; attempt: number }): void {
    console.error(`[TaskManager] ${taskType} (${jobId}) failed on attempt ${attempt}:`, error)
    captureException(error, { tags: { component: 'task-manager', taskType }, extra: { jobId, attempt } })
  }

  private inOrder(call: (schedule: Schedule) => Promise<unknown> | unknown): Promise<unknown> {
    // Inside the object itself (a task scheduling more work), the call goes to it directly: through its stub it would come back to it.
    const run = async () => {
      const own = servingTaskManager()
      if (own) return call(own)
      await reachCurrentCode(this.objects, OBJECT_NAME, this.version)
      return call(this.objects.getByName(OBJECT_NAME))
    }
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }

  private handler(taskType: string): Task<unknown> {
    const task = this.handlers.get(taskType)
    if (!task) throw new Error(`No task is registered for type ${taskType}`)
    return task
  }

  /** The payload as the object stores it: JSON its schema accepts once it is read back. */
  private checkedPayloadJson(taskType: string, payload: unknown): string {
    const task = this.handler(taskType)
    let json: string
    try {
      json = JSON.stringify(payload ?? null)
    } catch (error) {
      throw new Error(`The payload of task ${taskType} cannot be stored`, { cause: error })
    }
    return JSON.stringify(task.payloadSchema.parse(JSON.parse(json)))
  }
}
