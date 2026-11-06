/**
 * The org's background work in one Durable Object, the CFTaskManager of the planned TaskManager
 * (SUP-1539, SUP-1540). That interface has no code yet, so this object boots SuperAgent and runs
 * its existing background services on their own timers, minus the ones that watch local
 * containers: each container belongs to its agent's object. An alarm wakes the object after an
 * eviction.
 *
 * A deploy replaces the object, but the replaced instance's timers keep firing (SUP-1284: a
 * scheduled task ran twice). From then on its storage refuses writes, so a small write on a timer
 * tells an instance it was replaced, and it stops its services.
 */
import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectNamespace, DurableObjectState, DurableObjectStub } from 'cloudflare:workers'
import type { Env } from './index'

/** The name of the org's one task manager. */
const OBJECT_NAME = 'org'
/** How often the alarm wakes an evicted object. */
const WAKE_EVERY_MS = 60_000
/** How often an instance checks that it is still the live one. */
const CHECK_EVERY_MS = 10_000

export function taskManagerOf(objects: DurableObjectNamespace<CloudflareTaskManager>): DurableObjectStub<CloudflareTaskManager> {
  return objects.getByName(OBJECT_NAME)
}

export class CloudflareTaskManager extends DurableObject<Env> {
  private started: Promise<void> | undefined
  private liveCheck: ReturnType<typeof setInterval> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS live_check (id INTEGER PRIMARY KEY CHECK (id = 1), checked_at INTEGER NOT NULL)')
  }

  /** Starts the background services unless they already run here, and arms the alarm. */
  async wake(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + WAKE_EVERY_MS)
    await this.start()
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + WAKE_EVERY_MS)
    await this.start()
  }

  private start(): Promise<void> {
    this.started ??= this.startServices().catch((error: unknown) => {
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
      clearInterval(this.liveCheck)
      console.warn('[task-manager] storage refused a write: a newer instance replaced this one, so its background services stop', error)
      stopServices().catch((stopError: unknown) => console.error('[task-manager] stopping the background services failed:', stopError))
    }
  }
}
