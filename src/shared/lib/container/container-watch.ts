/**
 * The checks on one agent's container, which the agent's actor owns, as it
 * owns the idle alarm. Each is a recurring task-manager job for this one agent.
 *
 * - Every 300 s, whether the container runs. A container can exit without
 *   this process (a crash, a kill, a runtime that restarted), and a read that
 *   failed shows a running container as stopped. So this runs from the time
 *   the container runtime has a client until the runtime is dropped, whatever
 *   the container last read as.
 * - Every 30 s, the container's health (the memory and CPU warnings the app
 *   shows), while the runtime sees the container running.
 *
 * A check that hangs holds up only its own agent: the manager skips that
 * agent's passes while one runs, and every other agent has its own jobs.
 *
 * Tasks on their own, with no service around them, like the session index's
 * wakeup: they register on the manager in use the first time a watch starts.
 */
import { z } from 'zod'
import pLimit from 'p-limit'
import { background } from '../background'
import { Task, taskManager, type TaskManager, type TaskResult } from '../background-work'

/** Interval for checking that a running container still runs (in ms). Default: 300 seconds */
const STATUS_CHECK_INTERVAL_MS = parseInt(
  process.env.CONTAINER_STATUS_SYNC_INTERVAL_SECONDS || '300',
  10
) * 1000

/** Interval for checking a running container's health (in ms). Default: 30 seconds */
const HEALTH_CHECK_INTERVAL_MS = parseInt(
  process.env.CONTAINER_HEALTH_CHECK_INTERVAL_SECONDS || '30',
  10
) * 1000

/**
 * Status checks of this process's agents at once, one runner call each. The
 * watches of containers found running together come due together; the
 * actors of one process share its runtime, so the bound is theirs to keep.
 */
const statusChecks = pLimit(4)

export interface ContainerWatchDeps {
  /** One health check of the running container. */
  checkHealth(): Promise<void>
  /** Ask the runtime whether the container still runs, and update what the app shows. */
  checkStatus(): Promise<void>
}

/**
 * The way from the container layer to the agents' watches, which their actors
 * own. Attached to the container host by the agent registry, like
 * `AgentIdleAlarms`.
 */
export interface AgentContainerWatches {
  /** The agent's watch, from an actor made if none is held: a running container always has one. */
  get(slug: string): ContainerWatch
  /** The agent's watch when its actor is held. A stop or a drop never makes an actor. */
  peek(slug: string): ContainerWatch | undefined
}

const payloadSchema = z.object({ agentSlug: z.string() }).strict()
type Payload = z.infer<typeof payloadSchema>

/**
 * What each agent with a started watch checks. A function cannot go in a
 * payload, so the payload names the agent and this holds the calls. On
 * `globalThis`, like the manager whose jobs name its keys: a handler
 * registered by one instance of this module (before a dev-server reload, or a
 * test's `vi.resetModules()`) serves the watches of another.
 */
const WATCHED = Symbol.for('superagent.container-watch')
const watched = ((globalThis as Record<symbol, Map<string, ContainerWatchDeps> | undefined>)[WATCHED] ??= new Map())

class ContainerCheckTask extends Task<Payload> {
  readonly payloadSchema = payloadSchema

  constructor(readonly type: string, private readonly check: (deps: ContainerWatchDeps) => Promise<void>) {
    super()
  }

  async execute({ agentSlug }: Payload): Promise<TaskResult<Payload>> {
    const deps = watched.get(agentSlug)
    if (deps) await this.check(deps)
    return { kind: 'done' }
  }
}

const statusCheckTask = new ContainerCheckTask('container-watch.status', (deps) => statusChecks(() => deps.checkStatus()))
const healthCheckTask = new ContainerCheckTask('container-watch.health', (deps) => deps.checkHealth())

export class ContainerWatch {
  /** The manager the jobs are set on, while the status job runs. */
  private manager: TaskManager | null = null
  private checkingHealth = false

  constructor(private readonly slug: string, private readonly deps: ContainerWatchDeps) {}

  /**
   * Start the status job; nothing when it runs already. Nothing either when
   * no task manager is installed (a script that only reads), or once
   * dispatch has stopped: the containers are about to stop.
   */
  start(): void {
    if (this.manager) return
    let manager: TaskManager
    try {
      manager = taskManager()
    } catch {
      return
    }
    if (!manager.accepts()) return
    this.manager = manager
    watched.set(this.slug, this.deps)
    this.set(manager, statusCheckTask, STATUS_CHECK_INTERVAL_MS)
  }

  /** The container is seen running: start the health job too. */
  startHealth(): void {
    this.start()
    const manager = this.manager
    if (!manager || this.checkingHealth) return
    this.checkingHealth = true
    this.set(manager, healthCheckTask, HEALTH_CHECK_INTERVAL_MS)
  }

  /** The container is seen stopped: its health job ends, its status job goes on. */
  stopHealth(): void {
    const manager = this.manager
    if (!manager || !this.checkingHealth) return
    this.checkingHealth = false
    this.cancel(manager, healthCheckTask)
  }

  /** Cancel both jobs: the container's runtime or the agent's actor was dropped. */
  stop(): void {
    const manager = this.manager
    if (!manager) return
    this.stopHealth()
    this.cancel(manager, statusCheckTask)
    this.manager = null
    if (watched.get(this.slug) === this.deps) watched.delete(this.slug)
  }

  isWatching(): boolean {
    return this.manager !== null
  }

  isCheckingHealth(): boolean {
    return this.checkingHealth
  }

  private set(manager: TaskManager, task: ContainerCheckTask, intervalMs: number): void {
    if (!manager.handles(task.type)) manager.register(task)
    background(
      manager.ensureEvery(this.jobId(task), { taskType: task.type, payload: { agentSlug: this.slug } }, { intervalMs }),
      { name: `${task.type}.start` },
    )
  }

  private cancel(manager: TaskManager, task: ContainerCheckTask): void {
    background(manager.cancel(this.jobId(task)), { name: `${task.type}.stop` })
  }

  private jobId(task: ContainerCheckTask): string {
    return `${task.type}:${this.slug}`
  }
}
