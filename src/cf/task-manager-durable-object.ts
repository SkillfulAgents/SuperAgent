/**
 * The org's background work in one Durable Object: where CloudflareTaskManager keeps the schedule
 * and runs it. Jobs live in this object's SQLite and survive it; the object wakes on its alarm for
 * the next one that is due. It boots SuperAgent and starts the background services, so their
 * Tasks run here, through this isolate's handlers, and the services that hold sockets keep them
 * here. The services that watch local containers are not registered: each container belongs to
 * its agent's object.
 *
 * The rules are LocalTaskManager's (docs/background-work.md): one run per id, a recurring pass that
 * comes due during a run is skipped, a replaced or cancelled run's result is ignored, retries keep
 * the occurrence. What is kept in memory is only what is running.
 *
 * A deploy replaces the object, but the replaced instance keeps the sockets and timers its services
 * hold (SUP-1284). From then on its storage refuses writes, so a small write on a timer tells an
 * instance it was replaced, and it stops its services.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectNamespace, DurableObjectState, DurableObjectStub } from 'cloudflare:workers'
import type { Env } from './index'

/** The name of the org's one task manager object. */
const OBJECT_NAME = 'org'
/** How often an instance checks that it is still the live one. */
const CHECK_EVERY_MS = 10_000

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

// A type, not an interface: SQL row types must be assignable to Record<string, SqlStorageValue>.
type JobRow = {
  id: string
  /** Changes whenever the job is scheduled anew: a run of an older one finds it changed. */
  gen: string
  task_type: string
  payload: string
  interval_ms: number | null
  jitter_ratio: number | null
  /** A one-off's wakeup, or a recurring job's retry. */
  wake_at: number | null
  /** A recurring job's next pass. */
  tick_at: number | null
  execution_id: string | null
  attempt: number
}

interface Run {
  gen: string
  controller: AbortController
}

const serving = new AsyncLocalStorage<TaskManagerDurableObject>()

/** The org's task manager object when it is the one serving the current request; null otherwise. */
export function servingTaskManager(): TaskManagerDurableObject | null {
  return serving.getStore() ?? null
}

export function taskManagerOf(objects: DurableObjectNamespace<TaskManagerDurableObject>): DurableObjectStub<TaskManagerDurableObject> {
  return objects.getByName(OBJECT_NAME)
}

export class TaskManagerDurableObject extends DurableObject<Env> {
  private readonly runs = new Map<string, Run>()
  private started: Promise<void> | undefined
  private stopped = false
  private liveCheck: ReturnType<typeof setInterval> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = ctx.storage.sql
    sql.exec('CREATE TABLE IF NOT EXISTS job (id TEXT PRIMARY KEY, gen TEXT NOT NULL, task_type TEXT NOT NULL, payload TEXT NOT NULL, interval_ms INTEGER, jitter_ratio REAL, wake_at INTEGER, tick_at INTEGER, execution_id TEXT, attempt INTEGER NOT NULL DEFAULT 0)')
    sql.exec('CREATE TABLE IF NOT EXISTS live_check (id INTEGER PRIMARY KEY CHECK (id = 1), checked_at INTEGER NOT NULL)')
  }

  /** Starts the background services unless they already run here. Each isolate of the org calls it once. */
  async wake(): Promise<void> {
    await this.start()
  }

  async alarm(): Promise<void> {
    await this.start()
    await this.dispatch()
  }

  /** Replaces whatever is scheduled under `id` with a one-off at `runAt`. A run in flight finishes; its result is ignored. */
  async scheduleAt(id: string, taskType: string, payloadJson: string, runAt: number): Promise<void> {
    if (this.stopped) return
    this.write(id, taskType, payloadJson, null, runAt, null)
    await this.rearm()
  }

  /** Keeps one recurring job under `id`; one already recurring there is left as it is. */
  async scheduleEvery(id: string, taskType: string, payloadJson: string, periodic: Periodic): Promise<void> {
    const current = this.row(id)
    if (this.stopped || (current && current.interval_ms !== null)) return
    this.write(id, taskType, payloadJson, periodic, null, this.now() + (periodic.initialDelayMs ?? this.interval(periodic)))
    await this.rearm()
  }

  /** Removes the job and aborts a run in flight. */
  async cancelJob(id: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM job WHERE id = ?', id)
    this.runs.get(id)?.controller.abort(new Error(`Job ${id} was cancelled`))
    await this.rearm()
  }

  /** Nothing runs in this instance after this. The jobs stay stored, for the next instance. */
  stopDispatch(): void {
    this.stopped = true
    clearInterval(this.liveCheck)
    for (const [id, run] of this.runs) run.controller.abort(new Error(`Dispatch stopped while ${id} was running`))
  }

  /** The clock jobs are scheduled against; a test moves it. */
  protected now(): number {
    return Date.now()
  }

  private start(): Promise<void> {
    this.started ??= serving.run(this, () => this.startServices()).catch((error: unknown) => {
      this.started = undefined
      throw error
    })
    return this.started
  }

  private async startServices(): Promise<void> {
    const app = await import('./boot')
    await app.boot(this.env)
    await app.startBackgroundServices()
    this.liveCheck = setInterval(() => this.checkLive(app.stopBackgroundServices), CHECK_EVERY_MS)
  }

  private checkLive(stopServices: () => Promise<void>): void {
    try {
      this.ctx.storage.sql.exec('INSERT INTO live_check (id, checked_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET checked_at = excluded.checked_at', Date.now())
    } catch (error) {
      console.warn('[task-manager] storage refused a write: a newer instance replaced this one, so its background services stop', error)
      this.stopDispatch()
      serving.run(this, stopServices).catch((stopError: unknown) => console.error('[task-manager] stopping the background services failed:', stopError))
    }
  }

  /** Starts every job that is due and not running; each one that settles looks again. */
  private async dispatch(): Promise<void> {
    if (this.stopped) return
    const now = this.now()
    const due = this.ctx.storage.sql.exec<JobRow>('SELECT * FROM job WHERE wake_at <= ? OR tick_at <= ?', now, now).toArray()
    const runs: Promise<void>[] = []
    for (const job of due) {
      if (job.tick_at !== null && job.tick_at <= now && job.interval_ms !== null) {
        // The next pass is set when this one comes due, as an interval's next tick is.
        const tickAt = now + this.interval({ intervalMs: job.interval_ms, jitterRatio: job.jitter_ratio ?? undefined })
        this.ctx.storage.sql.exec('UPDATE job SET tick_at = ? WHERE id = ? AND gen = ?', tickAt, job.id, job.gen)
        // A pass that comes due during a run is skipped, and does not queue up.
        if (this.runs.has(job.id)) continue
        // A retry still waiting gives way: this pass starts a new occurrence.
        this.ctx.storage.sql.exec('UPDATE job SET wake_at = NULL, execution_id = NULL, attempt = 0 WHERE id = ? AND gen = ?', job.id, job.gen)
        runs.push(this.run({ ...job, wake_at: null, execution_id: null, attempt: 0 }))
      } else if (!this.runs.has(job.id)) {
        // A one-off stays due until its run settles, so a restart mid-run runs it again.
        runs.push(this.run(job))
      }
    }
    await this.rearm()
    await Promise.all(runs)
  }

  private async run(job: JobRow): Promise<void> {
    const app = await import('./boot')
    const tasks = app.backgroundTasks()
    if (!tasks.handles(job.task_type)) {
      console.error(`[task-manager] no task is registered for type ${job.task_type}; dropping job ${job.id}`)
      this.ctx.storage.sql.exec('DELETE FROM job WHERE id = ? AND gen = ?', job.id, job.gen)
      return
    }
    const controller = new AbortController()
    const executionId = job.execution_id ?? crypto.randomUUID()
    const attempt = job.attempt + 1
    this.ctx.storage.sql.exec('UPDATE job SET execution_id = ?, attempt = ? WHERE id = ? AND gen = ?', executionId, attempt, job.id, job.gen)
    const run: Run = { gen: job.gen, controller }
    this.runs.set(job.id, run)
    try {
      const outcome = await serving.run(this, () => tasks.execute(job.task_type, job.payload, {
        jobId: job.id,
        executionId,
        attempt,
        signal: controller.signal,
        now: () => this.now(),
      }))
      this.settle(job, attempt, controller.signal, outcome, tasks)
    } finally {
      if (this.runs.get(job.id) === run) this.runs.delete(job.id)
    }
    // Whatever is scheduled under this id now, or came due meanwhile.
    await this.dispatch()
  }

  private settle(job: JobRow, attempt: number, signal: AbortSignal, outcome: ExecutionOutcome, tasks: { report(error: unknown, context: { taskType: string; jobId: string; attempt: number }): void }): void {
    const sql = this.ctx.storage.sql
    // Replaced or cancelled while it ran: what this run decided no longer applies.
    const current = this.row(job.id)?.gen === job.gen
    const context = { taskType: job.task_type, jobId: job.id, attempt }
    const finish = () => {
      if (job.interval_ms !== null) sql.exec('UPDATE job SET wake_at = NULL, execution_id = NULL, attempt = 0 WHERE id = ? AND gen = ?', job.id, job.gen)
      else sql.exec('DELETE FROM job WHERE id = ? AND gen = ?', job.id, job.gen)
    }
    if (outcome.kind === 'failed') {
      // It failed because it was told to stop, or its failure no longer concerns anyone.
      if (!current && signal.aborted) return
      if (current && outcome.retryInMs !== undefined) {
        console.warn(`[TaskManager] ${job.task_type} (${job.id}) failed on attempt ${attempt}; retrying in ${outcome.retryInMs}ms:`, outcome.error)
        sql.exec('UPDATE job SET wake_at = ? WHERE id = ? AND gen = ?', this.now() + outcome.retryInMs, job.id, job.gen)
        return
      }
      tasks.report(outcome.error, context)
      if (current) finish()
      return
    }
    if (!current) return
    if (outcome.kind === 'done') return finish()
    if (outcome.kind === 'retry') {
      sql.exec('UPDATE job SET wake_at = ? WHERE id = ? AND gen = ?', outcome.at, job.id, job.gen)
      return
    }
    if (job.interval_ms !== null) {
      tasks.report(new Error(`Recurring job ${job.id} returned a next occurrence; its passes are already scheduled`), context)
      return finish()
    }
    sql.exec('UPDATE job SET payload = ?, wake_at = ?, execution_id = NULL, attempt = 0 WHERE id = ? AND gen = ?', outcome.payloadJson, outcome.at, job.id, job.gen)
  }

  private write(id: string, taskType: string, payloadJson: string, periodic: Periodic | null, wakeAt: number | null, tickAt: number | null): void {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO job (id, gen, task_type, payload, interval_ms, jitter_ratio, wake_at, tick_at, execution_id, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)',
      id, crypto.randomUUID(), taskType, payloadJson, periodic?.intervalMs ?? null, periodic?.jitterRatio ?? null, wakeAt, tickAt,
    )
  }

  private row(id: string): JobRow | undefined {
    return this.ctx.storage.sql.exec<JobRow>('SELECT * FROM job WHERE id = ?', id).toArray()[0]
  }

  /** The alarm for the next time anything comes due. A running job's retry or wakeup waits for its run to settle. */
  private async rearm(): Promise<void> {
    if (this.stopped) return
    let next: number | null = null
    for (const job of this.ctx.storage.sql.exec<JobRow>('SELECT * FROM job').toArray()) {
      const times = [job.tick_at, this.runs.has(job.id) ? null : job.wake_at].filter((at): at is number => at !== null)
      for (const at of times) if (next === null || at < next) next = at
    }
    if (next !== null) await this.ctx.storage.setAlarm(next)
    else await this.ctx.storage.deleteAlarm()
  }

  private interval({ intervalMs, jitterRatio }: Periodic): number {
    if (!jitterRatio) return intervalMs
    return Math.max(0, intervalMs * (1 + (Math.random() * 2 - 1) * jitterRatio))
  }
}
