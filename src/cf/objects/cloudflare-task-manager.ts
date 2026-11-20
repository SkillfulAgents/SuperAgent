/**
 * The TaskManager on Cloudflare: the CFTaskManager of docs/background-work.md.
 *
 * CloudflareTaskManager is the TaskManager of every isolate of the org. Handlers are registered
 * there, as on LocalTaskManager, and payloads are checked the same way. `at`, `ensureEvery` and
 * `cancel` go to the org's TaskManagerDurableObject, in the order they are called.
 *
 * TaskManagerDurableObject keeps the schedule in its SQLite, so jobs survive it, and wakes on its
 * alarm for the next one that is due. It boots SuperAgent and starts the background services, so
 * their Tasks run there, through its isolate's handlers, and the services that hold sockets keep
 * them there. The rules are LocalTaskManager's: one run per id, a recurring pass that comes due
 * during a run is skipped, a replaced or cancelled run's result is ignored, retries keep the
 * occurrence. What is kept in memory is only what is running.
 *
 * One difference follows from the stored schedule: a recurring job outlives the code that scheduled
 * it. So the first `ensureEvery` an instance gets for a job replaces a stored one whose task,
 * payload or interval differs; after that the job is left as it is, as on LocalTaskManager.
 *
 * A deploy replaces the object, but the replaced instance keeps the sockets and timers its services
 * hold (SUP-1284). From then on its storage refuses writes, so a small write on a timer tells an
 * instance it was replaced, and it stops its services.
 *
 * The deploy steps live here too, because this is the one object of the org that every deploy
 * starts: it migrates the database and runs the org's setup once per deploy (prepareDeploy, migrate,
 * prepareOrg). The API routes it serves itself are listed at needsLiveConnections.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectNamespace, DurableObjectState } from 'cloudflare:workers'
import type { Env } from '../index'
import { nearStorage } from '../lib/object-location'
import { reachCurrentCode, restartIfOlder, type VersionMetadata } from '../lib/object-version'
import { Task, TaskManager, type PeriodicOptions, type RetryPolicy, type TaskContext, type TaskSpec } from '@shared/lib/background-work'
import { captureException } from '@shared/lib/error-reporting'

/** The name of the org's one task manager object. */
const OBJECT_NAME = 'org'
/** How often an instance checks that it is still the live one. */
const CHECK_EVERY_MS = 10_000
/** How long a job waits before this code looks again at a task type it does not know. */
const UNKNOWN_TASK_RETRY_MS = 10 * 60_000
/** The steps of a deploy, each run once per deploy (prepareDeploy). */
const MIGRATE_STEP = 'migrate'
const PREPARE_ORG_STEP = 'prepare-org'
/** Recorded once the deployment's seed settings were applied: a later deploy does not apply them again. */
const SEED_STEP = 'seed'
const ONCE = 'once'
/** While a job runs, the alarm looks again this often: a run lost with its instance is started again. */
const RUNNING_CHECK_MS = 60_000

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

/**
 * The API routes that read or change the live chat connections. The connections live where the
 * background services run, in the task manager object, so it serves these requests itself: an add,
 * a pause, a send or a status read in any other isolate would act on a manager that never started.
 */
const LIVE_CONNECTION_ROUTES = [
  /^\/api\/(agent|chat)-integrations(\/|$)/,
  /^\/api\/agents\/[^/]+\/chat-integrations$/,
  /^\/api\/home-graph(\/|$)/,
  // The relay's connection is one of them: its status is read where the relay runs.
  /^\/api\/webhook-relay(\/|$)/,
  /^\/api\/x-agent\/(chat|meetings)(\/|$)/,
  // A sign-in the user makes from a login card: its session is then watched for minutes, on
  // timers that a request's isolate does not keep after the answer.
  /^\/api\/agents\/[^/]+\/sessions\/[^/]+\/(fill-login|login-via)$/,
]

export function needsLiveConnections(pathname: string): boolean {
  return LIVE_CONNECTION_ROUTES.some((route) => route.test(pathname))
}

/** One API request served in the org's task manager object (needsLiveConnections). */
export async function serveInTaskManager(request: Request, env: Pick<Env, 'TASK_MANAGER' | 'VERSION'>): Promise<Response> {
  await reachCurrentCode(env.TASK_MANAGER, OBJECT_NAME, env.VERSION?.timestamp)
  return env.TASK_MANAGER.getByName(OBJECT_NAME).fetch(request)
}

/** Makes sure the org's task manager runs its services, once it runs this deploy's code or newer. */
export async function startTaskManager(env: Pick<Env, 'TASK_MANAGER' | 'VERSION'>, origin?: string): Promise<void> {
  await reachCurrentCode(env.TASK_MANAGER, OBJECT_NAME, env.VERSION?.timestamp)
  await env.TASK_MANAGER.getByName(OBJECT_NAME).wake(origin)
}

/**
 * Resolves once the org's database is at this deploy's schema and data. The task manager object
 * migrates it once per deploy.
 */
export async function ensureMigrated(env: Pick<Env, 'TASK_MANAGER' | 'VERSION'>): Promise<void> {
  // The object's own boot: a call through its stub would come back to it.
  const own = servingTaskManager()
  if (own) return void (await own.migrate())
  await reachCurrentCode(env.TASK_MANAGER, OBJECT_NAME, env.VERSION?.timestamp)
  if (!(await env.TASK_MANAGER.getByName(OBJECT_NAME).migrate(env.VERSION))) throw new DeployStepNotReady(MIGRATE_STEP)
}

/**
 * Resolves once the org's once-per-deploy setup has run (prepareOrg in boot.ts).
 */
export async function ensureOrgPrepared(env: Pick<Env, 'TASK_MANAGER' | 'VERSION'>, origin?: string): Promise<void> {
  const own = servingTaskManager()
  if (own) return void (await own.prepareOrg())
  await reachCurrentCode(env.TASK_MANAGER, OBJECT_NAME, env.VERSION?.timestamp)
  if (!(await env.TASK_MANAGER.getByName(OBJECT_NAME).prepareOrg(env.VERSION, origin))) throw new DeployStepNotReady(PREPARE_ORG_STEP)
}

/**
 * The task manager object still runs another deploy's code, so it did not run this deploy's step.
 * After an upload the Worker answers on the new code at once, but the object can go on with the
 * previous code for some seconds: there the step would find its own deploy's work done and
 * return, and this deploy's migration and setup would wait for the next deploy. The deploy step
 * answers "try again" instead, and its caller does.
 */
export class DeployStepNotReady extends Error {
  constructor(step: string) {
    super(`the task manager object does not run this deploy's code yet: ${step} did not run`)
    this.name = 'DeployStepNotReady'
  }
}

/**
 * The deploy step, right after an upload: migrates the org's database and runs its setup for this
 * deploy, before the new code serves a request. A deploy that skips it is not lost: the task manager
 * object runs both when it starts (startServices), and requests that arrive before it has finished
 * run on the previous schema. `origin` is the origin the caller reached this deploy at.
 */
export async function prepareDeploy(env: Pick<Env, 'TASK_MANAGER' | 'VERSION'>, origin?: string): Promise<void> {
  await ensureMigrated(env)
  await ensureOrgPrepared(env, origin)
}

export class TaskManagerDurableObject extends DurableObject<Env> {
  private readonly steps = new Map<string, Promise<void>>()
  private readonly runs = new Map<string, Run>()
  /** The recurring jobs this instance was asked to keep: only the first ask may replace a stored job. */
  private readonly ensured = new Set<string>()
  /** Jobs whose unknown task type this instance reported: once, not at every pass. */
  private readonly unknownReported = new Set<string>()
  private started: Promise<void> | undefined
  private stopped = false
  private liveCheck: ReturnType<typeof setInterval> | undefined
  /** The origin a caller reached this deploy at, for a deployment that names none (APP_ORIGIN). */
  private origin: string | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, nearStorage(env))
    const sql = ctx.storage.sql
    sql.exec('CREATE TABLE IF NOT EXISTS job (id TEXT PRIMARY KEY, gen TEXT NOT NULL, task_type TEXT NOT NULL, payload TEXT NOT NULL, interval_ms INTEGER, jitter_ratio REAL, wake_at INTEGER, tick_at INTEGER, execution_id TEXT, attempt INTEGER NOT NULL DEFAULT 0)')
    sql.exec('CREATE TABLE IF NOT EXISTS live_check (id INTEGER PRIMARY KEY CHECK (id = 1), checked_at INTEGER NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS deploy_step (step TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY (step, version))')
  }

  checkVersion(callerVersion: string): boolean {
    return restartIfOlder(this.ctx, this.env.VERSION, callerVersion)
  }

  /**
   * Migrates the org's database unless this deploy already did. A failed migration is tried again
   * by the next call. False when `caller` names another deploy than this object's code: the step
   * is not run here (runsDeployOf).
   */
  async migrate(caller?: VersionMetadata): Promise<boolean> {
    if (!this.runsDeployOf(caller)) return false
    await this.oncePerDeploy(MIGRATE_STEP, async () => (await import('../boot')).migrateDatabase(this.env))
    return true
  }

  /** Runs the org's setup unless this deploy already did, on a boot of this isolate that does not wait for it. False as for migrate. */
  async prepareOrg(caller?: VersionMetadata, origin?: string): Promise<boolean> {
    if (!this.runsDeployOf(caller)) return false
    this.origin ??= origin
    await this.oncePerDeploy(PREPARE_ORG_STEP, async () => {
      const app = await import('../boot')
      await app.bootIsolate(this.env)
      const sql = this.ctx.storage.sql
      // The seed is for a new org: applied by one deploy, it is not applied again by the next.
      const seed = sql.exec('SELECT 1 FROM deploy_step WHERE step = ? AND version = ?', SEED_STEP, ONCE).toArray().length === 0
      await app.prepareOrg(this.env, { seed, origin: this.env.APP_ORIGIN ?? this.origin })
      if (seed && this.env.SEED_SETTINGS?.trim()) sql.exec('INSERT OR IGNORE INTO deploy_step (step, version) VALUES (?, ?)', SEED_STEP, ONCE)
    })
    return true
  }

  /**
   * Whether this object's code is the caller's deploy. A step is recorded under the deploy of the
   * code that ran it, so an object on the previous code must not run it for a newer caller: it
   * would find its own deploy's step recorded and do nothing. It restarts instead, as for
   * checkVersion, so a later call reaches the new code.
   */
  private runsDeployOf(caller: VersionMetadata | undefined): boolean {
    const own = this.env.VERSION
    if (!caller || !own || caller.id === own.id) return true
    restartIfOlder(this.ctx, own, caller.timestamp)
    return false
  }

  private oncePerDeploy(step: string, run: () => Promise<void>): Promise<void> {
    let done = this.steps.get(step)
    if (!done) {
      done = this.runStep(step, run).catch((error: unknown) => {
        this.steps.delete(step)
        throw error
      })
      this.steps.set(step, done)
    }
    return done
  }

  private async runStep(step: string, run: () => Promise<void>): Promise<void> {
    const version = this.env.VERSION?.id
    const sql = this.ctx.storage.sql
    if (version && sql.exec('SELECT 1 FROM deploy_step WHERE step = ? AND version = ?', step, version).toArray().length > 0) return
    try {
      await run()
    } catch (error) {
      captureException(error, { tags: { component: 'task-manager', operation: `deploy-step.${step}` }, extra: { version }, level: 'fatal' })
      throw error
    }
    if (version) sql.exec('INSERT OR IGNORE INTO deploy_step (step, version) VALUES (?, ?)', step, version)
  }

  /** Starts the background services unless they already run here. Each isolate of the org calls it once. */
  async wake(origin?: string): Promise<void> {
    this.origin ??= origin
    await this.start()
  }

  /** An API request that needs the services running here (serveInTaskManager). */
  async fetch(request: Request): Promise<Response> {
    await this.start()
    const app = await import('../boot')
    return serving.run(this, () => app.serveInObject(request, this.env))
  }

  /**
   * Starts what is due and returns: the runtime runs one alarm at a time and ends one after 15
   * minutes, so a job that runs long must neither hold back the others nor be cut off with the alarm.
   */
  async alarm(): Promise<void> {
    try {
      await this.start()
      await this.dispatch()
    } catch (error) {
      // The runtime runs a failed alarm again; the failure is reported each time.
      captureException(error, { tags: { component: 'task-manager', operation: 'alarm' } })
      throw error
    }
  }

  /** Replaces whatever is scheduled under `id` with a one-off at `runAt`. A run in flight finishes; its result is ignored. */
  async scheduleAt(id: string, taskType: string, payloadJson: string, runAt: number): Promise<void> {
    if (this.stopped) return
    this.write(id, taskType, payloadJson, null, runAt, null)
    await this.rearm()
  }

  /**
   * Keeps one recurring job under `id`; one already recurring there is left as it is. The stored
   * job can come from an earlier deploy, so the first call an instance gets for `id` replaces one
   * whose task, payload or interval is not the one asked for.
   */
  async scheduleEvery(id: string, taskType: string, payloadJson: string, periodic: Periodic): Promise<void> {
    if (this.stopped) return
    const current = this.row(id)
    const first = !this.ensured.has(id)
    this.ensured.add(id)
    if (current && current.interval_ms !== null) {
      const same = current.task_type === taskType && current.payload === payloadJson && current.interval_ms === periodic.intervalMs && (current.jitter_ratio ?? null) === (periodic.jitterRatio ?? null)
      if (same || !first) return
    }
    this.write(id, taskType, payloadJson, periodic, null, this.now() + (periodic.initialDelayMs ?? this.interval(periodic)))
    await this.rearm()
  }

  /** Removes the job and aborts a run in flight. */
  async cancelJob(id: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM job WHERE id = ?', id)
    this.ensured.delete(id)
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

  /**
   * The deploy's steps first, then the services. A deploy step that already ran left nothing to do
   * here (oncePerDeploy); a deploy that skipped it is migrated and set up now, so no deployment
   * depends on a call from outside to get its schema. A step that fails is reported, and the next
   * wake or alarm tries the start again.
   */
  private async startServices(): Promise<void> {
    await this.migrate()
    await this.prepareOrg()
    const app = await import('../boot')
    await app.boot(this.env)
    // A replaced instance in this isolate shut the services down for good, so here this one would
    // start none. It starts over instead, which can bring it up in another isolate.
    if (app.backgroundServicesShutDown()) {
      const error = new Error('The background services of this isolate were shut down by a replaced instance')
      captureException(error, { tags: { component: 'task-manager', operation: 'start-services' } })
      this.ctx.abort(error.message)
    }
    await app.startBackgroundServices()
    this.liveCheck = setInterval(() => this.checkLive(app.stopBackgroundServices), CHECK_EVERY_MS)
  }

  private checkLive(stopServices: () => Promise<void>): void {
    try {
      this.ctx.storage.sql.exec('INSERT INTO live_check (id, checked_at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET checked_at = excluded.checked_at', Date.now())
    } catch (error) {
      console.warn('[task-manager] storage refused a write: a newer instance replaced this one, so its background services stop', error)
      this.stopDispatch()
      serving.run(this, stopServices).catch((stopError: unknown) => {
        console.error('[task-manager] stopping the background services failed:', stopError)
        captureException(stopError, { tags: { component: 'task-manager', operation: 'stop-replaced-services' } })
      })
    }
  }

  /**
   * Starts every job that is due and not running, arms the alarm, and returns. The runs go on in
   * the background; each one that settles looks again.
   */
  private async dispatch(): Promise<void> {
    if (this.stopped) return
    const tasks = (await import('../boot')).backgroundTasks()
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
        runs.push(this.run({ ...job, wake_at: null, execution_id: null, attempt: 0 }, tasks))
      } else if (!this.runs.has(job.id)) {
        // A one-off stays due until its run settles, so a restart mid-run runs it again.
        runs.push(this.run(job, tasks))
      }
    }
    await this.rearm()
    if (runs.length > 0) this.ctx.waitUntil(Promise.all(runs).catch((error: unknown) => this.reportRunFailure(error)))
  }

  /** A run whose bookkeeping failed, not its task: a replaced instance's storage refuses the write, and says nothing. */
  private reportRunFailure(error: unknown): void {
    if (this.stopped) return
    console.error('[task-manager] settling a run failed:', error)
    captureException(error, { tags: { component: 'task-manager', operation: 'settle-run' } })
  }

  /** Marks the job as running before it returns, so no later look starts it twice. */
  private run(job: JobRow, tasks: CloudflareTaskManager): Promise<void> {
    if (!tasks.handles(job.task_type)) {
      // Code that does not know the type (an older deploy during a rollout, or after a rollback) keeps the
      // job for code that does: a one-off or a retry waits and is looked at again, a recurring job keeps its passes.
      if (!this.unknownReported.has(job.id)) {
        this.unknownReported.add(job.id)
        tasks.report(new Error(`No task is registered for type ${job.task_type}; job ${job.id} is kept and looked at again later`), { taskType: job.task_type, jobId: job.id, attempt: job.attempt })
      }
      this.ctx.storage.sql.exec('UPDATE job SET wake_at = ? WHERE id = ? AND gen = ? AND wake_at IS NOT NULL', this.now() + UNKNOWN_TASK_RETRY_MS, job.id, job.gen)
      return Promise.resolve()
    }
    const controller = new AbortController()
    const executionId = job.execution_id ?? crypto.randomUUID()
    const attempt = job.attempt + 1
    this.ctx.storage.sql.exec('UPDATE job SET execution_id = ?, attempt = ? WHERE id = ? AND gen = ?', executionId, attempt, job.id, job.gen)
    const run: Run = { gen: job.gen, controller }
    this.runs.set(job.id, run)
    return this.finish(job, run, executionId, attempt, tasks)
  }

  private async finish(job: JobRow, run: Run, executionId: string, attempt: number, tasks: CloudflareTaskManager): Promise<void> {
    try {
      const outcome = await serving.run(this, () => tasks.execute(job.task_type, job.payload, {
        jobId: job.id,
        executionId,
        attempt,
        signal: run.controller.signal,
        now: () => this.now(),
      }))
      this.settle(job, attempt, run.controller.signal, outcome, tasks)
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
    // While anything runs, the alarm also comes back soon: it is what outlives this instance.
    let next: number | null = this.runs.size > 0 ? this.now() + RUNNING_CHECK_MS : null
    for (const job of this.ctx.storage.sql.exec<Pick<JobRow, 'id' | 'wake_at' | 'tick_at'>>('SELECT id, wake_at, tick_at FROM job').toArray()) {
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

type Schedule = Pick<TaskManagerDurableObject, 'scheduleAt' | 'scheduleEvery' | 'cancelJob' | 'stopDispatch'>

function retryDelay(policy: RetryPolicy, attempt: number): number | undefined {
  if (policy.delaysMs.length === 0) return undefined
  if (attempt >= (policy.maxAttempts ?? policy.delaysMs.length + 1)) return undefined
  return policy.delaysMs[Math.min(attempt - 1, policy.delaysMs.length - 1)]
}

export class CloudflareTaskManager extends TaskManager {
  private readonly handlers = new Map<string, Task<unknown>>()
  // Calls on one job take effect in the order they are made, as docs/background-work.md asks of every
  // backend. Per job, not one chain for the isolate: a call whose request was cancelled midway never
  // settles, and would hold every later call behind it.
  private readonly queues = new Map<string, Promise<unknown>>()
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
    await this.inOrder(id, (schedule) => schedule.scheduleAt(id, spec.taskType, payloadJson, runAt))
  }

  async ensureEvery<P>(id: string, spec: TaskSpec<P>, options: PeriodicOptions): Promise<void> {
    const payloadJson = this.checkedPayloadJson(spec.taskType, spec.payload)
    if (!(options.intervalMs > 0)) throw new Error(`Task ${spec.taskType} (${id}) was scheduled with an invalid interval`)
    if (this.stopped) return
    await this.inOrder(id, (schedule) => schedule.scheduleEvery(id, spec.taskType, payloadJson, { intervalMs: options.intervalMs, initialDelayMs: options.initialDelayMs, jitterRatio: options.jitterRatio }))
  }

  async cancel(id: string): Promise<void> {
    await this.inOrder(id, (schedule) => schedule.cancelJob(id))
  }

  /** Dispatch is the object's alarm; an isolate has nothing to start. */
  async start(): Promise<void> {
    this.stopped = false
  }

  /**
   * In the task manager object (a replaced instance stopping its services), only that instance
   * stops: its dispatch ends and its jobs stay stored for the next instance. The isolate goes on
   * scheduling, because Cloudflare can run other objects of the org in it, and what they schedule
   * goes to the org's live instance. Anywhere else, nothing is scheduled from this isolate after this.
   */
  async stop(): Promise<void> {
    const own = servingTaskManager()
    if (own) own.stopDispatch()
    else this.stopped = true
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

  private inOrder(jobId: string, call: (schedule: Schedule) => Promise<unknown> | unknown): Promise<unknown> {
    // Inside the object itself (a task scheduling more work), the call goes to it directly: through its stub it would come back to it.
    const run = async () => {
      const own = servingTaskManager()
      if (own) return call(own)
      await reachCurrentCode(this.objects, OBJECT_NAME, this.version)
      return call(this.objects.getByName(OBJECT_NAME))
    }
    const next = (this.queues.get(jobId) ?? Promise.resolve()).then(run, run)
    const tail = next.catch(() => {})
    this.queues.set(jobId, tail)
    void tail.then(() => {
      if (this.queues.get(jobId) === tail) this.queues.delete(jobId)
    })
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
