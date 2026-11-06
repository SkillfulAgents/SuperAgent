/**
 * The TaskManager of a process that keeps running: handlers, jobs and retry
 * state in memory, on ordinary timers. Everything pending is lost when the
 * process exits; a service registers again on startup, and a domain with its own
 * records (cron schedules) rebuilds its wakeups from them. See
 * docs/background-work.md.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { background } from '../background'
import { Task, TaskManager, type PeriodicOptions, type RetryPolicy, type TaskContext, type TaskResult, type TaskSpec } from './task'

/**
 * The longest a one-off wakeup waits on one timer before it looks at the clock
 * again. Process timers stop counting while the machine sleeps, and the clock
 * does not: without this, a wakeup due during a two-hour sleep would run two
 * hours late. This also keeps a far-off wakeup under the limit of setTimeout
 * (about 24.8 days), past which it would fire at once.
 *
 * Recurring jobs do not look at the clock. They wait like an interval timer,
 * asleep or not.
 */
const WAKEUP_RECHECK_MS = 60_000

export interface TaskFailureContext {
  taskType: string
  jobId: string
  attempt: number
}

export interface LocalTaskManagerOptions {
  now?: () => number
  random?: () => number
  report?: (error: unknown, context: TaskFailureContext) => void
}

export interface LocalJobInfo {
  id: string
  taskType: string
  recurring: boolean
  /** When the next run is due: the wakeup's time, or the time a recurring job's next pass or retry was set for. */
  nextRunAt: number | null
  running: boolean
  attempt: number
}

export interface LocalTaskInfo {
  taskType: string
  runs: number
  failures: number
  lastRunAt: number | null
  lastError: string | null
}

interface Job {
  readonly id: string
  readonly taskType: string
  readonly periodic: PeriodicOptions | null
  payload: unknown
  /** A one-off's wakeup, or a recurring job's retry. */
  wakeAt: number | null
  wakeTimer: ReturnType<typeof setTimeout> | null
  /** A recurring job's next pass. */
  tickAt: number | null
  tickTimer: ReturnType<typeof setTimeout> | null
  /** Came due while an earlier run under this id was going; it runs when that one settles. */
  waiting: boolean
  executionId: string | null
  attempt: number
}

interface Run {
  readonly controller: AbortController
}

function reportFailure(error: unknown, { taskType, jobId, attempt }: TaskFailureContext): void {
  console.error(`[TaskManager] ${taskType} (${jobId}) failed on attempt ${attempt}:`, error)
  // Loaded on the first failure: error reporting brings the Sentry SDK, which
  // this module's importers do not otherwise load.
  background(async () => {
    const { captureException } = await import('../error-reporting')
    captureException(error, { tags: { component: 'task-manager', taskType }, extra: { jobId, attempt } })
  }, { name: 'task-manager.report-failure' })
}

function retryDelay(policy: RetryPolicy, attempt: number): number | undefined {
  if (policy.delaysMs.length === 0) return undefined
  if (attempt >= (policy.maxAttempts ?? policy.delaysMs.length + 1)) return undefined
  return policy.delaysMs[Math.min(attempt - 1, policy.delaysMs.length - 1)]
}

export class LocalTaskManager extends TaskManager {
  private readonly handlers = new Map<string, Task<unknown>>()
  private readonly jobs = new Map<string, Job>()
  // Runs by job id. Outlives a job that was replaced or cancelled while it ran,
  // so its successor still waits for it.
  private readonly runs = new Map<string, Run>()
  private readonly taskInfo = new Map<string, LocalTaskInfo>()
  private dispatching = false
  private stopped = false
  private readonly now: () => number
  private readonly random: () => number
  private readonly report: (error: unknown, context: TaskFailureContext) => void
  // The scope this manager was created in (an entry point's: none). Tasks run
  // in it, whoever scheduled them.
  private readonly detached = AsyncLocalStorage.snapshot()

  constructor(options: LocalTaskManagerOptions = {}) {
    super()
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? Math.random
    this.report = options.report ?? reportFailure
  }

  register<P>(task: Task<P>): void {
    this.handlers.set(task.type, task as Task<unknown>)
  }

  handles(taskType: string): boolean {
    return this.handlers.has(taskType)
  }

  async at<P>(runAt: number, id: string, spec: TaskSpec<P>): Promise<void> {
    const payload = this.checkedPayload(spec.taskType, spec.payload)
    if (!Number.isFinite(runAt)) throw new Error(`Task ${spec.taskType} (${id}) was scheduled at an invalid time`)
    if (this.stopped) return
    this.discard(id)
    const job = this.createJob(id, spec.taskType, payload, null)
    job.wakeAt = runAt
    this.jobs.set(id, job)
    this.armWake(job)
  }

  async ensureEvery<P>(id: string, spec: TaskSpec<P>, options: PeriodicOptions): Promise<void> {
    const payload = this.checkedPayload(spec.taskType, spec.payload)
    if (!(options.intervalMs > 0)) throw new Error(`Task ${spec.taskType} (${id}) was scheduled with an invalid interval`)
    if (this.stopped || this.jobs.get(id)?.periodic) return
    this.discard(id)
    const job = this.createJob(id, spec.taskType, payload, options)
    this.jobs.set(id, job)
    this.armTick(job, options.initialDelayMs ?? this.interval(options))
  }

  async cancel(id: string): Promise<void> {
    this.discard(id)
    this.runs.get(id)?.controller.abort(new Error(`Job ${id} was cancelled`))
  }

  async start(): Promise<void> {
    if (this.dispatching) return
    this.dispatching = true
    this.stopped = false
    for (const job of this.jobs.values()) {
      if (job.periodic) this.armTick(job, job.periodic.initialDelayMs ?? this.interval(job.periodic))
      else this.armWake(job)
    }
  }

  /**
   * Nothing is armed after this, whatever a run still in flight comes back with.
   * Runs are aborted and not waited for: a service's teardown does not wait on
   * work it did not wait on before.
   */
  async stop(): Promise<void> {
    this.dispatching = false
    this.stopped = true
    for (const id of [...this.jobs.keys()]) this.discard(id)
    for (const [id, run] of this.runs) run.controller.abort(new Error(`Dispatch stopped while ${id} was running`))
  }

  /** What is scheduled now, for tests and diagnostics. */
  scheduled(): LocalJobInfo[] {
    return [...this.jobs.values()].map(job => ({
      id: job.id,
      taskType: job.taskType,
      recurring: job.periodic !== null,
      nextRunAt: job.wakeAt ?? job.tickAt,
      running: this.runs.has(job.id),
      attempt: job.attempt,
    }))
  }

  /** How each task type has run in this process, for tests and diagnostics. */
  taskStats(): LocalTaskInfo[] {
    return [...this.taskInfo.values()].map(info => ({ ...info }))
  }

  private createJob(id: string, taskType: string, payload: unknown, periodic: PeriodicOptions | null): Job {
    return { id, taskType, periodic, payload, wakeAt: null, wakeTimer: null, tickAt: null, tickTimer: null, waiting: false, executionId: null, attempt: 0 }
  }

  private handler(taskType: string): Task<unknown> {
    const task = this.handlers.get(taskType)
    if (!task) throw new Error(`No task is registered for type ${taskType}`)
    return task
  }

  /** The payload as a backend would get it back: through JSON, then its schema. */
  private checkedPayload(taskType: string, payload: unknown): unknown {
    const task = this.handler(taskType)
    let stored: unknown
    try {
      stored = JSON.parse(JSON.stringify(payload ?? null))
    } catch (error) {
      throw new Error(`The payload of task ${taskType} cannot be stored`, { cause: error })
    }
    return task.payloadSchema.parse(stored)
  }

  private discard(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.jobs.delete(id)
    this.clearWake(job)
    if (job.tickTimer) clearTimeout(job.tickTimer)
    job.tickTimer = null
    job.tickAt = null
    job.waiting = false
  }

  private clearWake(job: Job): void {
    if (job.wakeTimer) clearTimeout(job.wakeTimer)
    job.wakeTimer = null
    job.wakeAt = null
  }

  private interval({ intervalMs, jitterRatio }: PeriodicOptions): number {
    if (!jitterRatio) return intervalMs
    return Math.max(0, intervalMs * (1 + (this.random() * 2 - 1) * jitterRatio))
  }

  private armWake(job: Job): void {
    if (job.wakeTimer) clearTimeout(job.wakeTimer)
    job.wakeTimer = null
    if (!this.dispatching || job.wakeAt === null) return
    const delay = Math.max(0, job.wakeAt - this.now())
    job.wakeTimer = setTimeout(() => {
      job.wakeTimer = null
      if (this.jobs.get(job.id) !== job || job.wakeAt === null) return
      // Timers can fire a moment early by the clock, and a slice of a long wait always does.
      if (this.now() < job.wakeAt) {
        this.armWake(job)
        return
      }
      job.wakeAt = null
      this.dueWake(job)
    }, Math.min(delay, WAKEUP_RECHECK_MS))
    job.wakeTimer.unref?.()
  }

  private armTick(job: Job, delay: number): void {
    if (job.tickTimer) clearTimeout(job.tickTimer)
    job.tickTimer = null
    job.tickAt = null
    if (!this.dispatching || !job.periodic) return
    job.tickAt = this.now() + delay
    job.tickTimer = setTimeout(() => {
      job.tickTimer = null
      if (this.jobs.get(job.id) !== job || !job.periodic) return
      // Set when this pass comes due, not when it ends, as an interval's next tick is.
      this.armTick(job, this.interval(job.periodic))
      // A pass that comes due during a run is skipped, and does not queue up.
      if (this.runs.has(job.id)) return
      // A retry still waiting gives way: this pass starts a new occurrence.
      this.clearWake(job)
      job.executionId = null
      job.attempt = 0
      this.run(job)
    }, delay)
    job.tickTimer.unref?.()
  }

  private dueWake(job: Job): void {
    if (this.runs.has(job.id)) {
      job.waiting = true
      return
    }
    this.run(job)
  }

  private run(job: Job): void {
    const task = this.handler(job.taskType)
    const controller = new AbortController()
    job.executionId ??= randomUUID()
    job.attempt += 1
    const ctx: TaskContext = {
      jobId: job.id,
      executionId: job.executionId,
      attempt: job.attempt,
      signal: controller.signal,
      now: () => this.now(),
    }
    const info = this.infoFor(job.taskType)
    info.runs += 1
    info.lastRunAt = this.now()
    const attempt = job.attempt
    const run: Run = { controller }
    this.runs.set(job.id, run)
    background(this.detached(async () => task.execute(job.payload, ctx))
      .then(
        result => this.settled(job, task, result),
        error => this.failed(job, task, attempt, controller.signal, error),
      )
      .finally(() => {
        if (this.runs.get(job.id) === run) this.runs.delete(job.id)
        // Whatever is scheduled under this id now and came due meanwhile.
        const next = this.jobs.get(job.id)
        if (!next?.waiting || this.runs.has(job.id)) return
        next.waiting = false
        this.run(next)
      }), { name: `task.${job.taskType}` })
  }

  private settled(job: Job, task: Task<unknown>, result: TaskResult<unknown>): void {
    // Replaced or cancelled while it ran, or dispatch stopped: what this run
    // decided no longer applies, and must not disturb what came after it.
    if (this.jobs.get(job.id) !== job) return
    switch (result.kind) {
      case 'done':
        this.finish(job)
        return
      case 'retry':
        this.scheduleRetry(job, result.at)
        return
      case 'next':
        this.scheduleNext(job, task, result)
        return
    }
  }

  private scheduleRetry(job: Job, at: number): void {
    job.wakeAt = at
    this.armWake(job)
  }

  private scheduleNext(job: Job, task: Task<unknown>, next: { at: number; payload: unknown }): void {
    if (job.periodic) {
      this.report(new Error(`Recurring job ${job.id} returned a next occurrence; its passes are already scheduled`), { taskType: job.taskType, jobId: job.id, attempt: job.attempt })
      this.finish(job)
      return
    }
    try {
      if (!Number.isFinite(next.at)) throw new Error(`Task ${job.taskType} (${job.id}) returned an invalid time`)
      job.payload = this.checkedPayload(task.type, next.payload)
    } catch (error) {
      this.report(error, { taskType: job.taskType, jobId: job.id, attempt: job.attempt })
      this.finish(job)
      return
    }
    job.executionId = null
    job.attempt = 0
    this.scheduleRetry(job, next.at)
  }

  private failed(job: Job, task: Task<unknown>, attempt: number, signal: AbortSignal, error: unknown): void {
    const current = this.jobs.get(job.id) === job
    // It failed because it was told to stop, or its failure no longer concerns anyone.
    if (!current && signal.aborted) return
    const info = this.infoFor(job.taskType)
    info.failures += 1
    info.lastError = error instanceof Error ? error.message : String(error)
    const delay = current && task.retryPolicy ? retryDelay(task.retryPolicy, attempt) : undefined
    if (delay === undefined) {
      this.report(error, { taskType: job.taskType, jobId: job.id, attempt })
      if (current) this.finish(job)
      return
    }
    console.warn(`[TaskManager] ${job.taskType} (${job.id}) failed on attempt ${attempt}; retrying in ${delay}ms:`, error)
    this.scheduleRetry(job, this.now() + delay)
  }

  private finish(job: Job): void {
    job.executionId = null
    job.attempt = 0
    if (job.periodic) return
    this.discard(job.id)
  }

  private infoFor(taskType: string): LocalTaskInfo {
    let info = this.taskInfo.get(taskType)
    if (!info) {
      info = { taskType, runs: 0, failures: 0, lastRunAt: null, lastError: null }
      this.taskInfo.set(taskType, info)
    }
    return info
  }
}
