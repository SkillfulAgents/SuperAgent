/**
 * AppState on Cloudflare. The org's AppStateDurableObject decides every keyed operation with
 * SuperAgent's own local rules (LocalAppStateBackend) over its SQLite, one call at a time, so each
 * one is atomic as it is in one process; it also carries events to the sockets that subscribed.
 * Every isolate and object of the org uses SuperAgent's typed AppState over an engine that sends
 * each operation to that object (createCloudflareAppState).
 */
import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectNamespace, DurableObjectState, SqlStorage, WorkerWebSocket } from 'cloudflare:workers'
import { createAppState, type AppState, type AppStateScope, type Expiry, type Revision } from '@shared/lib/app-state'
import type { AppStateEngine, EngineSubscriber, IncrementBounds, KeyPolicy, StoredEntry } from '@shared/lib/app-state/engine'
import { LocalAppStateBackend, type EntryStore } from '@shared/lib/app-state/local-app-state'
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

/** The local engine's entries in the object's SQLite, so they outlive the object. */
function sqliteEntryStore(sql: SqlStorage): EntryStore {
  sql.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, json TEXT NOT NULL, revision TEXT NOT NULL, expires_at INTEGER)')
  return {
    get(key) {
      const row = sql.exec<EntryRow>('SELECT json, revision, expires_at FROM app_state WHERE key = ?', key).toArray()[0]
      if (!row) return undefined
      return { json: row.json, revision: row.revision as Revision, expiresAt: row.expires_at === null ? null : Number(row.expires_at) }
    },
    put(key, entry) {
      sql.exec(
        'INSERT INTO app_state (key, json, revision, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json, revision = excluded.revision, expires_at = excluded.expires_at',
        key, entry.json, entry.revision, entry.expiresAt,
      )
    },
    delete(key) {
      sql.exec('DELETE FROM app_state WHERE key = ?', key)
    },
    deleteExpired(now) {
      sql.exec('DELETE FROM app_state WHERE expires_at <= ?', now)
    },
    get size() {
      return Number(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM app_state').toArray()[0]?.n ?? 0)
    },
  }
}

export class AppStateDurableObject extends DurableObject<Env> {
  private readonly engine: LocalAppStateBackend

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.engine = new LocalAppStateBackend({ store: sqliteEntryStore(ctx.storage.sql), now: () => this.now() })
  }

  checkVersion(callerVersion: string): boolean {
    return restartIfOlder(this.ctx, this.env.VERSION, callerVersion)
  }

  read(key: string): StoredEntry | null {
    return this.engine.read(key)
  }

  readMany(keys: string[]): (StoredEntry | null)[] {
    return this.engine.readMany(keys)
  }

  write(key: string, json: string, policy: KeyPolicy, expiry?: Expiry) {
    return this.engine.write(key, json, policy, expiry)
  }

  remove(key: string): void {
    this.engine.remove(key)
  }

  insertIfAbsent(key: string, json: string, policy: KeyPolicy, expiry?: Expiry) {
    return this.engine.insertIfAbsent(key, json, policy, expiry)
  }

  compareAndSet(key: string, expected: Revision | null, json: string, policy: KeyPolicy, expiry?: Expiry) {
    return this.engine.compareAndSet(key, expected, json, policy, expiry)
  }

  increment(key: string, delta: number, bounds: IncrementBounds, limits: IncrementBounds, policy: KeyPolicy, expiry?: Expiry) {
    return this.engine.increment(key, delta, bounds, limits, policy, expiry)
  }

  consume(key: string, revision?: Revision) {
    return this.engine.consume(key, revision)
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
  connect(fullChannels: readonly string[], onEvent: (fullChannel: string, json: string) => void, onLost: () => void): Promise<HubConnection>
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

export function createCloudflareAppState(objects: DurableObjectNamespace<AppStateDurableObject>, options: CloudflareAppStateOptions = {}): AppState {
  // A new stub for each call: a Worker invocation cannot use an I/O object that another one made.
  const call: ObjectCall = async <R>(run: (object: AppStateObject) => R | Promise<R>): Promise<Awaited<R>> => {
    await reachCurrentCode(objects, OBJECT_NAME, options.version)
    return await run(objects.getByName(OBJECT_NAME))
  }
  return createAppState({ scope: options.scope ?? ORG_SCOPE, engine: objectEngine(call, options.hub ?? objectHub(call)) })
}

type AppStateObject = ReturnType<DurableObjectNamespace<AppStateDurableObject>['getByName']>
/** One call on the org's object, made once the object runs this deploy's code or newer. */
type ObjectCall = <R>(run: (object: AppStateObject) => R | Promise<R>) => Promise<Awaited<R>>

function objectEngine(call: ObjectCall, hub: EventHub): AppStateEngine {
  return {
    read: (key) => call((object) => object.read(key)),
    readMany: async (keys) => (keys.length === 0 ? [] : call((object) => object.readMany([...keys]))),
    write: (key, json, policy, expiry) => call((object) => object.write(key, json, keyPolicy(policy), expiry)),
    remove: (key) => call((object) => object.remove(key)),
    insertIfAbsent: (key, json, policy, expiry) => call((object) => object.insertIfAbsent(key, json, keyPolicy(policy), expiry)),
    compareAndSet: (key, expected, json, policy, expiry) => call((object) => object.compareAndSet(key, expected, json, keyPolicy(policy), expiry)),
    increment: (key, delta, bounds, limits, policy, expiry) => call((object) => object.increment(key, delta, { ...bounds }, { ...limits }, keyPolicy(policy), expiry)),
    consume: (key, revision) => call((object) => object.consume(key, revision)),
    publish: (channel, json) => hub.publish(channel, json),
    subscribe: async (channels, subscriber) => {
      const subscription = new HubSubscription(hub, channels, subscriber)
      await subscription.open()
      return () => subscription.close()
    },
  }
}

/** Only the policy crosses to the object: a namespace also carries its schema and functions. */
const keyPolicy = ({ name, consistency, expiry }: Parameters<AppStateEngine['write']>[2]) => ({ name, consistency, expiry })

/** One subscription's socket to the hub, connected again while subscribed if the hub drops it. */
class HubSubscription {
  private active = true
  private connection: HubConnection | null = null
  private attempts = 0
  private retry: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly hub: EventHub,
    private readonly channels: readonly string[],
    private readonly subscriber: EngineSubscriber,
  ) {}

  async open(): Promise<void> {
    const connection = await this.hub.connect(this.channels, (channel, json) => this.subscriber.deliver(channel, json), () => this.lost())
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
