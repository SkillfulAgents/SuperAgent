/**
 * AppState for the org's isolates and Durable Objects. Every call goes to the org's
 * AppStateDurableObject: keyed state is one call per operation, so a conditional operation is
 * atomic there, and a publish is one call that the object sends on to the sockets subscribed to
 * its channel. Values are validated and encoded here with SuperAgent's own encoders, as
 * LocalAppState does.
 */
import type { DurableObjectNamespace, DurableObjectStub, WorkerWebSocket } from 'cloudflare:workers'
import type {
  AppState,
  AppStateScope,
  Channel,
  CompareAndSetResult,
  ConsumeOptions,
  ConsumeResult,
  Entry,
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
import { assertStrong, decodeValue, encodeValue, scopePrefix } from '@shared/lib/app-state/definitions'
import { background } from '@shared/lib/background'
import { SUBSCRIBE_PATH, type AppStateDurableObject, type HubMessage, type KeyPolicy, type StoredEntry } from './app-state-durable-object'

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
}

type AppStateObject = DurableObjectStub<AppStateDurableObject>

const policyOf = (namespace: Namespace<unknown>): KeyPolicy => ({ name: namespace.name, consistency: namespace.consistency, expiry: namespace.expiry })

export class CloudflareAppState implements AppState {
  readonly scope: AppStateScope
  private readonly prefix: string
  private readonly hub: EventHub
  private readonly subscriptions = new Set<HubSubscription<unknown>>()
  private closed = false

  constructor(
    private readonly objects: DurableObjectNamespace<AppStateDurableObject>,
    options: CloudflareAppStateOptions = {},
  ) {
    this.scope = options.scope ?? ORG_SCOPE
    this.prefix = scopePrefix(this.scope)
    this.hub = options.hub ?? objectHub(() => this.object())
  }

  async get<T>(key: StateKey<T>): Promise<Entry<T> | null> {
    this.assertOpen()
    return this.entryOf(key, await this.object().get(this.full(key)))
  }

  async getMany<T>(keys: readonly StateKey<T>[]): Promise<(Entry<T> | null)[]> {
    this.assertOpen()
    if (keys.length === 0) return []
    const stored = await this.object().getMany(keys.map((key) => this.full(key)))
    return Promise.all(keys.map((key, index) => this.entryOf(key, stored[index])))
  }

  async set<T>(key: StateKey<T>, value: T, options?: WriteOptions): Promise<Entry<T>> {
    this.assertOpen()
    const json = encodeValue(key.namespace.schema, value, key.path)
    return this.decoded(key, await this.object().set(this.full(key), json, policyOf(key.namespace), options?.expiry))
  }

  async delete<T>(key: StateKey<T>): Promise<void> {
    this.assertOpen()
    await this.object().delete(this.full(key))
  }

  async insertIfAbsent<T>(key: StateKey<T, 'strong'>, value: T, options?: WriteOptions): Promise<InsertResult<T>> {
    this.assertOpen()
    assertStrong(key, 'insertIfAbsent')
    const json = encodeValue(key.namespace.schema, value, key.path)
    const answer = await this.object().insertIfAbsent(this.full(key), json, policyOf(key.namespace), options?.expiry)
    return answer.inserted ? { inserted: true, entry: this.decoded(key, answer.entry) } : { inserted: false, current: this.decoded(key, answer.current) }
  }

  async compareAndSet<T>(key: StateKey<T, 'strong'>, expected: Revision | null, value: T, options?: WriteOptions): Promise<CompareAndSetResult<T>> {
    this.assertOpen()
    assertStrong(key, 'compareAndSet')
    const json = encodeValue(key.namespace.schema, value, key.path)
    const answer = await this.object().compareAndSet(this.full(key), expected, json, policyOf(key.namespace), options?.expiry)
    return answer.ok ? { ok: true, entry: this.decoded(key, answer.entry) } : { ok: false, current: answer.current && this.decoded(key, answer.current) }
  }

  async increment(key: StateKey<number, 'strong'>, delta = 1, options: IncrementOptions = {}): Promise<IncrementResult> {
    this.assertOpen()
    assertStrong(key, 'increment')
    if (!Number.isSafeInteger(delta)) throw new RangeError(`AppState increment of ${key.path}: the delta is a safe integer`)
    const answer = await this.object().increment(this.full(key), delta, { min: options.min, max: options.max }, policyOf(key.namespace), options.expiry)
    return answer.applied ? { applied: true, entry: this.decoded(key, answer.entry) } : { applied: false, current: answer.current && this.decoded(key, answer.current) }
  }

  async decrement(key: StateKey<number, 'strong'>, delta = 1, options?: IncrementOptions): Promise<IncrementResult> {
    return this.increment(key, -delta, options)
  }

  async consume<T>(key: StateKey<T, 'strong'>, options: ConsumeOptions = {}): Promise<ConsumeResult<T>> {
    this.assertOpen()
    assertStrong(key, 'consume')
    const answer = await this.object().consume(this.full(key), options.revision)
    return answer.consumed ? { consumed: true, entry: this.decoded(key, answer.entry) } : { consumed: false, current: answer.current && this.decoded(key, answer.current) }
  }

  async publish<E>(channel: Channel<E>, event: E): Promise<void> {
    this.assertOpen()
    await this.hub.publish(this.prefix + channel.path, encodeValue(channel.topic.schema, event, channel.path))
  }

  async subscribe<E>(channels: readonly Channel<E>[], listener: Listener<E>, options: SubscribeOptions = {}): Promise<Subscription> {
    this.assertOpen()
    if (channels.length === 0) throw new TypeError('AppState subscribe needs at least one channel')
    const { signal } = options
    const onAbort = () => subscription.end()
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
      subscription.end()
      return subscription
    }
    this.subscriptions.add(subscription as HubSubscription<unknown>)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await subscription.open()
    } catch (error) {
      subscription.end()
      throw error
    }
    return subscription
  }

  async close(): Promise<void> {
    this.closed = true
    for (const subscription of [...this.subscriptions]) subscription.end()
  }

  /** A new stub for each call: a Worker invocation cannot use an I/O object that another one made. */
  private object(): AppStateObject {
    return this.objects.getByName(OBJECT_NAME)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('This AppState is closed')
  }

  private full(key: StateKey<unknown>): string {
    return this.prefix + key.path
  }

  private decoded<T>(key: StateKey<T>, stored: StoredEntry): Entry<T> {
    return { value: decodeValue(key.namespace.schema, stored.json), revision: stored.revision as Revision, expiresAt: stored.expiresAt }
  }

  /**
   * The entry a caller gets: a fresh, validated copy. A value its schema now rejects is a miss in
   * an eventual namespace (a cache fetches it again) and an error in a strong one.
   */
  private async entryOf<T>(key: StateKey<T>, stored: StoredEntry | null): Promise<Entry<T> | null> {
    if (!stored) return null
    try {
      return this.decoded(key, stored)
    } catch (error) {
      if (key.namespace.consistency === 'strong') throw new Error(`AppState ${key.path} holds a value its schema rejects`, { cause: error })
      await this.object().delete(this.full(key))
      return null
    }
  }
}

/** One subscription: its own connection to the hub, opened from the invocation that subscribes. */
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
    const connection = await this.hub.connect([...this.channels.keys()], (channel, json) => this.deliver(channel, json), () => this.lost())
    if (!this.active) return connection.close()
    this.connection = connection
    this.attempts = 0
  }

  end(): void {
    if (!this.active) return
    this.active = false
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.connection?.close()
    this.connection = null
    this.onEnd(this)
  }

  async unsubscribe(): Promise<void> {
    this.end()
  }

  private deliver(fullChannel: string, json: string): void {
    const channel = this.channels.get(fullChannel)
    if (!channel || !this.active) return
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

  /** The hub dropped the connection (a deploy, an eviction): connect again while subscribed. Events published meanwhile are missed. */
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
function objectHub(object: () => AppStateObject): EventHub {
  return {
    async publish(fullChannel, json) {
      await object().publish(fullChannel, json)
    },
    async connect(fullChannels, onEvent, onLost) {
      const url = new URL(`https://app-state${SUBSCRIBE_PATH}`)
      for (const channel of fullChannels) url.searchParams.append('channel', channel)
      const response = await object().fetch(new Request(url, { headers: { Upgrade: 'websocket' } }))
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
