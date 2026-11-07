/**
 * AppState on Cloudflare. The org's AppStateDurableObject is the authority: it decides each keyed
 * operation in one SQLite transaction (`transactionSync`), so an operation is never a read and a
 * write split by the network. It also carries events to the sockets that subscribed. Every isolate
 * and object of the org uses CloudflareAppState, which sends each operation to that object as one call.
 */
import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectNamespace, DurableObjectState, WorkerWebSocket } from 'cloudflare:workers'
import {
  AppState,
  type AppStateScope,
  type CounterBounds,
  type EventSink,
  type Expiry,
  type KeyPolicy,
  type Revision,
  type StoredCompareAndSet,
  type StoredConsume,
  type StoredEntry,
  type StoredIncrement,
  type StoredInsert,
} from '@shared/lib/app-state'
import { resolveExpiry } from '@shared/lib/app-state/definitions'
import type { Env } from './index'
import { reachCurrentCode, restartIfOlder } from './object-version'

/** The path a subscription's WebSocket opens; each `channel` query value is one full channel. */
export const SUBSCRIBE_PATH = '/subscribe'

/** One event on a subscription's socket. */
export interface HubMessage {
  /** The full channel, scope prefix included. */
  c: string
  /** The event, as its topic schema encoded it. */
  j: string
}

interface Attachment {
  channels: string[]
}

type EntryRow = { json: string; revision: string; expires_at: number | null }

/** The fewest writes between two sweeps of expired entries. */
const SWEEP_AFTER_WRITES = 1_000

export class AppStateDurableObject extends DurableObject<Env> {
  // Revisions are `{epoch}.{sequence}`: a new instance of the object never issues one an earlier one did.
  private readonly epoch = crypto.randomUUID()
  private sequence = 0
  private writesUntilSweep = SWEEP_AFTER_WRITES

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, json TEXT NOT NULL, revision TEXT NOT NULL, expires_at INTEGER)')
  }

  checkVersion(callerVersion: string): boolean {
    return restartIfOlder(this.ctx, this.env.VERSION, callerVersion)
  }

  readMany(keys: string[]): (StoredEntry | null)[] {
    return this.atomically(() => keys.map((key) => this.read(key)))
  }

  write(key: string, json: string, policy: KeyPolicy, expiry?: Expiry): StoredEntry {
    return this.atomically(() => this.put(key, json, policy, expiry, this.read(key)))
  }

  remove(key: string): void {
    this.ctx.storage.sql.exec('DELETE FROM app_state WHERE key = ?', key)
  }

  insertIfAbsent(key: string, json: string, policy: KeyPolicy, expiry?: Expiry): StoredInsert {
    return this.atomically(() => {
      const current = this.read(key)
      if (current) return { inserted: false, current }
      return { inserted: true, entry: this.put(key, json, policy, expiry, null) }
    })
  }

  compareAndSet(key: string, expected: Revision | null, json: string, policy: KeyPolicy, expiry?: Expiry): StoredCompareAndSet {
    return this.atomically(() => {
      const current = this.read(key)
      if ((current?.revision ?? null) !== expected) return { ok: false, current }
      return { ok: true, entry: this.put(key, json, policy, expiry, current) }
    })
  }

  increment(key: string, delta: number, bounds: CounterBounds, limits: CounterBounds, policy: KeyPolicy, expiry?: Expiry): StoredIncrement {
    return this.atomically(() => {
      const current = this.read(key)
      const value = current ? (JSON.parse(current.json) as unknown) : 0
      if (typeof value !== 'number') throw new TypeError(`AppState counter ${key} does not hold a number`)
      const next = value + delta
      if (!Number.isSafeInteger(next)) throw new RangeError(`AppState counter ${key} would leave the safe integers`)
      if ((bounds.min !== undefined && next < bounds.min) || (bounds.max !== undefined && next > bounds.max)) {
        return { applied: false, current }
      }
      if ((limits.min !== undefined && next < limits.min) || (limits.max !== undefined && next > limits.max)) {
        throw new RangeError(`AppState counter ${key}: ${next} is outside what its schema accepts`)
      }
      return { applied: true, entry: this.put(key, JSON.stringify(next), policy, expiry, current) }
    })
  }

  consume(key: string, revision?: Revision): StoredConsume {
    return this.atomically(() => {
      const current = this.read(key)
      if (!current || (revision !== undefined && current.revision !== revision)) return { consumed: false, current }
      this.remove(key)
      return { consumed: true, entry: current }
    })
  }

  /** Sends the event to every socket subscribed to its channel; answers before any subscriber acts on it. */
  publish(fullChannel: string, json: string): { delivered: number } {
    const message = JSON.stringify({ c: fullChannel, j: json } satisfies HubMessage)
    let delivered = 0
    for (const socket of this.ctx.getWebSockets()) {
      if (!(socket.deserializeAttachment() as Attachment | null)?.channels.includes(fullChannel)) continue
      try {
        socket.send(message)
        delivered++
      } catch {
        // Closing: its subscriber connects again.
      }
    }
    return { delivered }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== SUBSCRIBE_PATH || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', { status: 404 })
    const channels = url.searchParams.getAll('channel')
    if (channels.length === 0) return new Response('No channel to subscribe to', { status: 400 })
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ channels } satisfies Attachment)
    return new Response(null, { status: 101, webSocket: client } as ResponseInit)
  }

  async webSocketMessage(): Promise<void> {
    // Subscribers send nothing.
  }

  async webSocketClose(socket: WorkerWebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason)
    } catch {
      // Already closed.
    }
  }

  /** The clock expiry is measured against; a test moves it. */
  protected now(): number {
    return Date.now()
  }

  /** Runs `decide` as one SQLite transaction: all its reads and writes, or none of its writes. */
  private atomically<T>(decide: () => T): T {
    return this.ctx.storage.transactionSync(decide)
  }

  /** The live entry; an expired one is deleted and reads as missing. */
  private read(key: string): StoredEntry | null {
    const row = this.ctx.storage.sql.exec<EntryRow>('SELECT json, revision, expires_at FROM app_state WHERE key = ?', key).toArray()[0]
    if (!row) return null
    const expiresAt = row.expires_at === null ? null : Number(row.expires_at)
    if (expiresAt !== null && expiresAt <= this.now()) {
      this.remove(key)
      return null
    }
    return { json: row.json, revision: row.revision as Revision, expiresAt }
  }

  private put(key: string, json: string, policy: KeyPolicy, expiry: Expiry | undefined, current: StoredEntry | null): StoredEntry {
    const now = this.now()
    const entry: StoredEntry = { json, revision: `${this.epoch}.${++this.sequence}` as Revision, expiresAt: resolveExpiry(policy, expiry, current ?? undefined, now) }
    this.ctx.storage.sql.exec(
      'INSERT INTO app_state (key, json, revision, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json, revision = excluded.revision, expires_at = excluded.expires_at',
      key, entry.json, entry.revision, entry.expiresAt,
    )
    if (--this.writesUntilSweep <= 0) {
      this.ctx.storage.sql.exec('DELETE FROM app_state WHERE expires_at <= ?', now)
      this.writesUntilSweep = SWEEP_AFTER_WRITES
    }
    return entry
  }
}

/** One org per Worker: the scope names the deployment, and the org is its only tenant. */
const ORG_SCOPE: AppStateScope = { deploymentId: 'cloudflare', tenantId: 'org' }
/** The name of the org's one AppStateDurableObject. */
const OBJECT_NAME = 'org'
/** Waits after a lost subscription socket before connecting again, longer each time. */
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

/** Where events travel between the org's isolates. */
export interface EventHub {
  publish(fullChannel: string, json: string): Promise<void>
  /** Receives the events of `fullChannels` until closed; resolves once subscribed. `onLost` runs once if the hub drops it. */
  connect(fullChannels: readonly string[], onEvent: EventSink, onLost: () => void): Promise<HubConnection>
}

export interface HubConnection {
  close(): void
}

export interface CloudflareAppStateOptions {
  /** The org's by default; a test opens several tenants over one object. */
  scope?: AppStateScope
  /** The org's object by default. */
  hub?: EventHub
  /** This deploy's time: the org's object restarts onto it if it runs older code (object-version.ts). */
  version?: string
}

type AppStateObject = ReturnType<DurableObjectNamespace<AppStateDurableObject>['getByName']>
/** One call on the org's object, made once the object runs this deploy's code or newer. */
type ObjectCall = <R>(run: (object: AppStateObject) => R | Promise<R>) => Promise<Awaited<R>>

/** Only the policy crosses to the object: a namespace also carries its schema and functions. */
const keyPolicy = ({ name, consistency, expiry }: KeyPolicy): KeyPolicy => ({ name, consistency, expiry })

/** Sends each operation to the org's object as one call, which the object decides atomically. */
export class CloudflareAppState extends AppState {
  private readonly hub: EventHub
  private readonly call: ObjectCall

  constructor(objects: DurableObjectNamespace<AppStateDurableObject>, options: CloudflareAppStateOptions = {}) {
    super(options.scope ?? ORG_SCOPE)
    // A new stub for each call: a Worker invocation cannot use an I/O object that another one made.
    this.call = async <R>(run: (object: AppStateObject) => R | Promise<R>): Promise<Awaited<R>> => {
      await reachCurrentCode(objects, OBJECT_NAME, options.version)
      return await run(objects.getByName(OBJECT_NAME))
    }
    this.hub = options.hub ?? objectHub(this.call)
  }

  protected async readEntries(fullKeys: readonly string[]): Promise<(StoredEntry | null)[]> {
    return fullKeys.length === 0 ? [] : this.call((object) => object.readMany([...fullKeys]))
  }

  protected writeEntry(fullKey: string, json: string, policy: KeyPolicy, expiry?: Expiry): Promise<StoredEntry> {
    return this.call((object) => object.write(fullKey, json, keyPolicy(policy), expiry))
  }

  protected removeEntry(fullKey: string): Promise<void> {
    return this.call((object) => object.remove(fullKey))
  }

  protected insertEntry(fullKey: string, json: string, policy: KeyPolicy, expiry?: Expiry): Promise<StoredInsert> {
    return this.call((object) => object.insertIfAbsent(fullKey, json, keyPolicy(policy), expiry))
  }

  protected compareAndSetEntry(fullKey: string, expected: Revision | null, json: string, policy: KeyPolicy, expiry?: Expiry): Promise<StoredCompareAndSet> {
    return this.call((object) => object.compareAndSet(fullKey, expected, json, keyPolicy(policy), expiry))
  }

  protected incrementEntry(
    fullKey: string,
    delta: number,
    bounds: CounterBounds,
    limits: CounterBounds,
    policy: KeyPolicy,
    expiry?: Expiry,
  ): Promise<StoredIncrement> {
    return this.call((object) => object.increment(fullKey, delta, { ...bounds }, { ...limits }, keyPolicy(policy), expiry))
  }

  protected consumeEntry(fullKey: string, revision?: Revision): Promise<StoredConsume> {
    return this.call((object) => object.consume(fullKey, revision))
  }

  protected publishEvent(fullChannel: string, json: string): Promise<void> {
    return this.hub.publish(fullChannel, json)
  }

  protected async listen(fullChannels: readonly string[], sink: EventSink): Promise<() => Promise<void>> {
    const subscription = new HubSubscription(this.hub, fullChannels, sink)
    await subscription.open()
    return async () => subscription.close()
  }
}

/** One subscription's socket to the hub, connected again while subscribed if the hub drops it. */
class HubSubscription {
  private active = true
  private connection: HubConnection | null = null
  private attempts = 0
  private retry: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly hub: EventHub,
    private readonly channels: readonly string[],
    private readonly sink: EventSink,
  ) {}

  async open(): Promise<void> {
    const connection = await this.hub.connect(this.channels, this.sink, () => this.lost())
    if (!this.active) return connection.close()
    this.connection = connection
    this.attempts = 0
  }

  close(): void {
    this.active = false
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.connection?.close()
    this.connection = null
  }

  /** The hub dropped the connection (a deploy, an eviction). Events published meanwhile are missed. */
  private lost(): void {
    this.connection = null
    if (!this.active) return
    const delay = RECONNECT_MS[Math.min(this.attempts++, RECONNECT_MS.length - 1)]
    this.retry = setTimeout(() => {
      this.retry = null
      if (!this.active) return
      this.open().catch((error: unknown) => {
        console.error('[app-state] reconnecting a subscription failed:', error)
        this.lost()
      })
    }, delay)
  }
}

/** The org's object as the hub: a publish is one call, and each subscription holds its own socket there. */
function objectHub(call: ObjectCall): EventHub {
  return {
    async publish(fullChannel, json) {
      await call((object) => object.publish(fullChannel, json))
    },
    async connect(fullChannels, onEvent, onLost) {
      const url = new URL(`https://app-state${SUBSCRIBE_PATH}`)
      for (const channel of fullChannels) url.searchParams.append('channel', channel)
      const response = await call((object) => object.fetch(new Request(url, { headers: { Upgrade: 'websocket' } })))
      const socket = (response as Response & { webSocket?: WorkerWebSocket | null }).webSocket
      if (!socket) throw new Error(`The AppState object refused the subscription (${response.status})`)
      socket.accept()
      let done = false
      const lost = () => {
        if (done) return
        done = true
        onLost()
      }
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as HubMessage
        onEvent(message.c, message.j)
      })
      socket.addEventListener('close', lost)
      socket.addEventListener('error', lost)
      return {
        close() {
          done = true
          try {
            socket.close(1000, 'unsubscribed')
          } catch {
            // Already closing.
          }
        },
      }
    },
  }
}
