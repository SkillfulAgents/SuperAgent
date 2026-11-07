/**
 * AppState on Cloudflare. The org's AppStateDurableObject is the authority: it decides each keyed
 * operation in one SQLite transaction (`transactionSync`), so an operation is never a read and a
 * write split by the network. It also carries events to the sockets that subscribed. Every isolate
 * and object of the org uses CloudflareAppState, which validates and encodes values as
 * LocalAppState does and sends each operation to that object as one call.
 */
import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectNamespace, DurableObjectState, WorkerWebSocket } from 'cloudflare:workers'
import type { z } from 'zod'
import { background } from '@shared/lib/background'
import type {
  AppState,
  AppStateScope,
  Channel,
  CompareAndSetResult,
  ConsumeOptions,
  ConsumeResult,
  Entry,
  Expiry,
  IncrementOptions,
  IncrementResult,
  InsertResult,
  Listener,
  Namespace,
  Revision,
  StateKey,
  SubscribeOptions,
  Subscription,
  WriteOptions,
} from '@shared/lib/app-state'
import { assertStrong, decodeValue, encodeValue, resolveExpiry, scopePrefix } from '@shared/lib/app-state/definitions'
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

/** What deciding a write needs of its key's namespace; only this crosses to the object. */
export type KeyPolicy = Pick<Namespace<unknown>, 'name' | 'consistency' | 'expiry'>

interface StoredEntry {
  readonly json: string
  readonly revision: Revision
  readonly expiresAt: number | null
}

interface CounterBounds {
  readonly min?: number
  readonly max?: number
}

type EventSink = (fullChannel: string, json: string) => void

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

  insertIfAbsent(key: string, json: string, policy: KeyPolicy, expiry?: Expiry): { inserted: true; entry: StoredEntry } | { inserted: false; current: StoredEntry } {
    return this.atomically(() => {
      const current = this.read(key)
      if (current) return { inserted: false, current }
      return { inserted: true, entry: this.put(key, json, policy, expiry, null) }
    })
  }

  compareAndSet(key: string, expected: Revision | null, json: string, policy: KeyPolicy, expiry?: Expiry): { ok: true; entry: StoredEntry } | { ok: false; current: StoredEntry | null } {
    return this.atomically(() => {
      const current = this.read(key)
      if ((current?.revision ?? null) !== expected) return { ok: false, current }
      return { ok: true, entry: this.put(key, json, policy, expiry, current) }
    })
  }

  increment(key: string, delta: number, bounds: CounterBounds, limits: CounterBounds, policy: KeyPolicy, expiry?: Expiry): { applied: true; entry: StoredEntry } | { applied: false; current: StoredEntry | null } {
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

  consume(key: string, revision?: Revision): { consumed: true; entry: StoredEntry } | { consumed: false; current: StoredEntry | null } {
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

const keyPolicy = ({ name, consistency, expiry }: KeyPolicy): KeyPolicy => ({ name, consistency, expiry })

/**
 * The integers at the ends of what a counter's number schema accepts, so the object refuses a
 * result past them before it stores it: the object never sees the schema.
 */
function counterLimits(schema: z.ZodType<number>): CounterBounds {
  const { minValue, maxValue } = schema as z.ZodNumber
  const limit = (bound: number | null | undefined, inward: 1 | -1) => {
    if (typeof bound !== 'number' || !Number.isFinite(bound)) return undefined
    const value = inward > 0 ? Math.ceil(bound) : Math.floor(bound)
    // An exclusive bound (`positive()`, `lt(n)`) reports the value it excludes.
    return schema.safeParse(value).success ? value : value + inward
  }
  return { min: limit(minValue, 1), max: limit(maxValue, -1) }
}

/** AppState in every isolate and object of the org: each operation is one call to the org's object. */
export class CloudflareAppState implements AppState {
  readonly scope: AppStateScope
  private readonly prefix: string
  private readonly hub: EventHub
  private readonly subscriptions = new Set<HubSubscription<unknown>>()
  private readonly call: ObjectCall
  private closed = false

  constructor(objects: DurableObjectNamespace<AppStateDurableObject>, options: CloudflareAppStateOptions = {}) {
    this.scope = options.scope ?? ORG_SCOPE
    this.prefix = scopePrefix(this.scope)
    // A new stub for each call: a Worker invocation cannot use an I/O object that another one made.
    this.call = async <R>(run: (object: AppStateObject) => R | Promise<R>): Promise<Awaited<R>> => {
      await reachCurrentCode(objects, OBJECT_NAME, options.version)
      return await run(objects.getByName(OBJECT_NAME))
    }
    this.hub = options.hub ?? objectHub(this.call)
  }

  async get<T>(key: StateKey<T>): Promise<Entry<T> | null> {
    const [entry] = await this.getMany([key])
    return entry ?? null
  }

  async getMany<T>(keys: readonly StateKey<T>[]): Promise<(Entry<T> | null)[]> {
    this.assertOpen()
    if (keys.length === 0) return []
    const stored = await this.call((object) => object.readMany(keys.map((key) => this.full(key))))
    return Promise.all(keys.map((key, i) => this.entryOf(key, stored[i] ?? null)))
  }

  async set<T>(key: StateKey<T>, value: T, options?: WriteOptions): Promise<Entry<T>> {
    this.assertOpen()
    const json = encodeValue(key.namespace.schema, value, key.path)
    return this.decoded(key, await this.call((object) => object.write(this.full(key), json, keyPolicy(key.namespace), options?.expiry)))
  }

  async delete<T>(key: StateKey<T>): Promise<void> {
    this.assertOpen()
    await this.call((object) => object.remove(this.full(key)))
  }

  async insertIfAbsent<T>(key: StateKey<T, 'strong'>, value: T, options?: WriteOptions): Promise<InsertResult<T>> {
    this.assertOpen()
    assertStrong(key, 'insertIfAbsent')
    const json = encodeValue(key.namespace.schema, value, key.path)
    const answer = await this.call((object) => object.insertIfAbsent(this.full(key), json, keyPolicy(key.namespace), options?.expiry))
    if (answer.inserted) return { inserted: true, entry: this.decoded(key, answer.entry) }
    return { inserted: false, current: (await this.entryOf(key, answer.current))! }
  }

  async compareAndSet<T>(
    key: StateKey<T, 'strong'>,
    expected: Revision | null,
    value: T,
    options?: WriteOptions,
  ): Promise<CompareAndSetResult<T>> {
    this.assertOpen()
    assertStrong(key, 'compareAndSet')
    const json = encodeValue(key.namespace.schema, value, key.path)
    const answer = await this.call((object) => object.compareAndSet(this.full(key), expected, json, keyPolicy(key.namespace), options?.expiry))
    if (answer.ok) return { ok: true, entry: this.decoded(key, answer.entry) }
    return { ok: false, current: await this.entryOf(key, answer.current) }
  }

  async increment(key: StateKey<number, 'strong'>, delta = 1, options: IncrementOptions = {}): Promise<IncrementResult> {
    this.assertOpen()
    assertStrong(key, 'increment')
    if (!Number.isSafeInteger(delta)) throw new RangeError(`AppState increment of ${key.path}: the delta is a safe integer`)
    const bounds = { min: options.min, max: options.max }
    const limits = counterLimits(key.namespace.schema)
    const answer = await this.call((object) => object.increment(this.full(key), delta, bounds, limits, keyPolicy(key.namespace), options.expiry))
    if (answer.applied) return { applied: true, entry: this.decoded(key, answer.entry) }
    return { applied: false, current: await this.entryOf(key, answer.current) }
  }

  async decrement(key: StateKey<number, 'strong'>, delta = 1, options?: IncrementOptions): Promise<IncrementResult> {
    return this.increment(key, -delta, options)
  }

  async consume<T>(key: StateKey<T, 'strong'>, options: ConsumeOptions = {}): Promise<ConsumeResult<T>> {
    this.assertOpen()
    assertStrong(key, 'consume')
    const answer = await this.call((object) => object.consume(this.full(key), options.revision))
    if (answer.consumed) return { consumed: true, entry: (await this.entryOf(key, answer.entry))! }
    return { consumed: false, current: await this.entryOf(key, answer.current) }
  }

  async publish<E>(channel: Channel<E>, event: E): Promise<void> {
    this.assertOpen()
    await this.hub.publish(this.prefix + channel.path, encodeValue(channel.topic.schema, event, channel.path))
  }

  async subscribe<E>(channels: readonly Channel<E>[], listener: Listener<E>, options: SubscribeOptions = {}): Promise<Subscription> {
    this.assertOpen()
    if (channels.length === 0) throw new TypeError('AppState subscribe needs at least one channel')
    const { signal } = options
    const onAbort = () => background(subscription.unsubscribe(), { name: 'app-state.unsubscribe-on-abort' })
    const subscription = new HubSubscription<E>(
      this.hub,
      new Map(channels.map((channel) => [this.prefix + channel.path, channel])),
      listener,
      (ended) => {
        this.subscriptions.delete(ended as HubSubscription<unknown>)
        signal?.removeEventListener('abort', onAbort)
      },
    )
    if (signal?.aborted) {
      await subscription.unsubscribe()
      return subscription
    }
    this.subscriptions.add(subscription as HubSubscription<unknown>)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await subscription.open()
    } catch (error) {
      await subscription.unsubscribe()
      throw error
    }
    return subscription
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.subscriptions].map((subscription) => subscription.unsubscribe()))
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('This AppState is closed')
  }

  private full(key: StateKey<unknown>): string {
    return this.prefix + key.path
  }

  private decoded<T>(key: StateKey<T>, stored: StoredEntry): Entry<T> {
    return { value: decodeValue(key.namespace.schema, stored.json), revision: stored.revision, expiresAt: stored.expiresAt }
  }

  /** A fresh, validated copy. A value its schema now rejects is a miss in an eventual namespace and an error in a strong one. */
  private async entryOf<T>(key: StateKey<T>, stored: StoredEntry | null): Promise<Entry<T> | null> {
    if (!stored) return null
    try {
      return this.decoded(key, stored)
    } catch (error) {
      if (key.namespace.consistency === 'strong') {
        throw new Error(`AppState ${key.path} holds a value its schema rejects`, { cause: error })
      }
      await this.call((object) => object.remove(this.full(key)))
      return null
    }
  }
}

/** One subscription's socket to the hub, connected again while subscribed if the hub drops it. */
class HubSubscription<E> implements Subscription {
  private active = true
  private connection: HubConnection | null = null
  private attempts = 0
  private retry: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly hub: EventHub,
    private readonly channels: ReadonlyMap<string, Channel<E>>,
    private readonly listener: Listener<E>,
    private readonly onEnd: (subscription: HubSubscription<E>) => void,
  ) {}

  async open(): Promise<void> {
    const connection = await this.hub.connect([...this.channels.keys()], (fullChannel, json) => this.deliver(fullChannel, json), () => this.lost())
    if (!this.active) return connection.close()
    this.connection = connection
    this.attempts = 0
  }

  async unsubscribe(): Promise<void> {
    if (!this.active) return
    this.active = false
    this.onEnd(this)
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.connection?.close()
    this.connection = null
  }

  private deliver(fullChannel: string, json: string): void {
    const channel = this.channels.get(fullChannel)
    if (!channel) return
    background(
      async () => {
        // Listeners run after publish has resolved: it acknowledges acceptance only.
        await Promise.resolve()
        if (!this.active) return
        await this.listener(decodeValue(channel.topic.schema, json), channel)
      },
      { name: 'app-state.listener' },
    )
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
