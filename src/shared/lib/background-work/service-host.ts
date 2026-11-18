/**
 * The registry of the app's background services: when each starts, what happens
 * when one fails to, and the order they are released in. See
 * docs/background-work.md.
 */
import pLimit from 'p-limit'
import type { Task, TaskManager } from './task'

export type ServicePhase = 'eager' | 'background'

/**
 * Domain behaviour that starts with the app: its Task definitions, and hooks for
 * the resources it holds. It needs no hook just to clear a timer, since the
 * manager owns those, and a Task on its own needs no Service.
 */
export interface Service {
  readonly id: string
  /**
   * `eager` starts in registration order, each after the last, on the path that
   * boot waits for. `background` starts all at once, off that path. A service
   * with no phase starts when its owner calls `startService`, or never, when all
   * it has is a `stop`.
   */
  readonly phase?: ServicePhase
  /** A failed start fails the phase. Otherwise it is logged and the app runs without this service. */
  readonly critical?: boolean
  /**
   * Its start does open-ended work against the host (image pulls, catch-up,
   * connects), so it waits for one of the host's few startup slots, in
   * registration order. Only the background phase has them.
   */
  readonly startupIo?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each task has its own payload type; the host only hands them to the manager
  readonly tasks?: readonly Task<any>[]
  enabled?(): boolean | Promise<boolean>
  start?(): void | Promise<void>
  /**
   * Called when the host stops, whether or not this service got to start, so it
   * can release what it holds lazily. It can be called again if a start was in
   * flight, so it must be safe to repeat.
   */
  stop?(): void | Promise<void>
}

export interface ServiceHostOptions {
  /** How many `startupIo` starts run at once. */
  startupIoConcurrency?: number
}

export type ServiceState = 'registered' | 'disabled' | 'starting' | 'started' | 'failed'

interface Entry {
  readonly service: Service
  state: ServiceState
  starting?: Promise<void>
}

const DEFAULT_STARTUP_IO_CONCURRENCY = 3

export class ServiceHost {
  private readonly entries = new Map<string, Entry>()
  private readonly startupIo: ReturnType<typeof pLimit>
  private stopRequested = false
  private stopping: Promise<void> | null = null

  constructor(private readonly taskManager: TaskManager, options: ServiceHostOptions = {}) {
    this.startupIo = pLimit(options.startupIoConcurrency ?? DEFAULT_STARTUP_IO_CONCURRENCY)
  }

  /** Registers the service and its Task definitions. Starts nothing, and does no I/O. */
  register(service: Service): void {
    if (this.stopRequested) {
      console.warn(`[ServiceHost] Not registering ${service.id}: the host has stopped`)
      return
    }
    if (this.entries.has(service.id)) throw new Error(`Service ${service.id} is already registered`)
    for (const task of service.tasks ?? []) this.taskManager.register(task)
    this.entries.set(service.id, { service, state: 'registered' })
  }

  isRegistered(id: string): boolean {
    return this.entries.has(id)
  }

  /** Each service's state, for tests and diagnostics. */
  states(): Record<string, ServiceState> {
    return Object.fromEntries([...this.entries].map(([id, entry]) => [id, entry.state]))
  }

  /**
   * Starts the phase's services that have not started. Rejects with the first
   * critical failure; in the eager phase that also leaves the rest unstarted.
   */
  async start(phase: ServicePhase): Promise<void> {
    const entries = [...this.entries.values()].filter(entry => entry.service.phase === phase)
    if (phase === 'eager') {
      for (const entry of entries) await this.startEntry(entry)
      return
    }
    const starts = entries.map(entry =>
      entry.service.startupIo ? this.startupIo(() => this.startEntry(entry)) : this.startEntry(entry))
    await Promise.all(starts)
  }

  /** Starts a service whose owner decides when: one with no phase, or one that registered too late for its phase. */
  async startService(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Service ${id} is not registered`)
    await this.startEntry(entry)
  }

  /**
   * Stops dispatch, so no pass starts while services let go, then stops every
   * service, last registered first. One that fails to stop does not hold up the
   * rest. A start still in flight is not waited for; that service is stopped
   * again when it settles.
   */
  stop(): Promise<void> {
    this.stopRequested = true
    this.stopping ??= this.stopAll()
    return this.stopping
  }

  private async stopAll(): Promise<void> {
    try {
      await this.taskManager.stop()
    } catch (error) {
      console.error('[ServiceHost] Failed to stop task dispatch:', error)
    }
    for (const entry of [...this.entries.values()].reverse()) await this.stopEntry(entry)
  }

  private async stopEntry({ service }: Entry): Promise<void> {
    try {
      await service.stop?.()
    } catch (error) {
      console.error(`[ServiceHost] Failed to stop ${service.id}:`, error)
    }
  }

  private startEntry(entry: Entry): Promise<void> {
    entry.starting ??= this.runStart(entry)
    return entry.starting
  }

  private async runStart(entry: Entry): Promise<void> {
    const { service } = entry
    if (this.stopRequested) return
    try {
      if (service.enabled && !(await service.enabled())) {
        entry.state = 'disabled'
        return
      }
      if (this.stopRequested) return
      entry.state = 'starting'
      await service.start?.()
      entry.state = 'started'
    } catch (error) {
      entry.state = 'failed'
      console.error(`[ServiceHost] Failed to start ${service.id}:`, error)
      if (service.critical) throw error
    } finally {
      // A start in flight can outlive shutdown. It gets a second stop once it
      // has settled, so it cannot leave a timer or socket behind.
      if (this.stopRequested) await this.stopEntry(entry)
    }
  }
}
