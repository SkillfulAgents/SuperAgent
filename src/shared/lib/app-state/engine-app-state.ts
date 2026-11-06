/**
 * The typed AppState over an engine: values are validated and stored as JSON, so
 * a caller that changes what it read changes only its copy; every operation is
 * async; listeners run after `publish` resolved. The engine decides each
 * operation (engine.ts), so this layer is the same for every deployment.
 */
import { background } from '@shared/lib/background'
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
  Revision,
  StateKey,
  SubscribeOptions,
  Subscription,
  WriteOptions,
} from './contract'
import { assertStrong, counterLimits, decodeValue, encodeValue, scopePrefix } from './definitions'
import type { AppStateEngine, EngineSubscriber, StoredEntry } from './engine'

export interface EngineAppStateOptions {
  scope: AppStateScope
  engine: AppStateEngine
  /** Receives a listener's failure instead of it being reported as failed background work. */
  onListenerError?: (error: unknown, channel: Channel<unknown>) => void
}

export function createAppState(options: EngineAppStateOptions): AppState {
  return new EngineAppState(options.scope, options.engine, options.onListenerError)
}

class EngineSubscription<E> implements Subscription, EngineSubscriber {
  private active = true
  private stop: (() => void | Promise<void>) | null = null

  constructor(
    private readonly channels: ReadonlyMap<string, Channel<E>>,
    private readonly listener: Listener<E>,
    private readonly onListenerError: ((error: unknown, channel: Channel<unknown>) => void) | undefined,
    private readonly onEnd: (subscription: EngineSubscription<E>) => void,
  ) {}

  async start(engine: AppStateEngine): Promise<void> {
    const stop = await engine.subscribe([...this.channels.keys()], this)
    // Ended while the engine was subscribing.
    if (!this.active) await stop()
    else this.stop = stop
  }

  deliver(fullChannel: string, json: string): void {
    const channel = this.channels.get(fullChannel)
    if (!channel) return
    const onError = this.onListenerError
    background(
      async () => {
        // Listeners run after publish has resolved: it acknowledges acceptance only.
        await Promise.resolve()
        if (!this.active) return
        const event = decodeValue(channel.topic.schema, json)
        if (!onError) return this.listener(event, channel)
        try {
          await this.listener(event, channel)
        } catch (error) {
          onError(error, channel as Channel<unknown>)
        }
      },
      { name: 'app-state.listener' },
    )
  }

  async end(): Promise<void> {
    if (!this.active) return
    this.active = false
    this.onEnd(this)
    const stop = this.stop
    this.stop = null
    await stop?.()
  }

  unsubscribe(): Promise<void> {
    return this.end()
  }
}

class EngineAppState implements AppState {
  private readonly prefix: string
  private readonly subscriptions = new Set<EngineSubscription<unknown>>()
  private closed = false

  constructor(
    readonly scope: AppStateScope,
    private readonly engine: AppStateEngine,
    private readonly onListenerError: ((error: unknown, channel: Channel<unknown>) => void) | undefined,
  ) {
    this.prefix = scopePrefix(scope)
  }

  async get<T>(key: StateKey<T>): Promise<Entry<T> | null> {
    this.assertOpen()
    return this.entryOf(key, await this.engine.read(this.full(key)))
  }

  async getMany<T>(keys: readonly StateKey<T>[]): Promise<(Entry<T> | null)[]> {
    this.assertOpen()
    const stored = await this.engine.readMany(keys.map((key) => this.full(key)))
    return Promise.all(keys.map((key, i) => this.entryOf(key, stored[i] ?? null)))
  }

  async set<T>(key: StateKey<T>, value: T, options?: WriteOptions): Promise<Entry<T>> {
    this.assertOpen()
    const json = encodeValue(key.namespace.schema, value, key.path)
    return this.decoded(key, await this.engine.write(this.full(key), json, key.namespace, options?.expiry))
  }

  async delete<T>(key: StateKey<T>): Promise<void> {
    this.assertOpen()
    await this.engine.remove(this.full(key))
  }

  async insertIfAbsent<T>(key: StateKey<T, 'strong'>, value: T, options?: WriteOptions): Promise<InsertResult<T>> {
    this.assertOpen()
    assertStrong(key, 'insertIfAbsent')
    const json = encodeValue(key.namespace.schema, value, key.path)
    const answer = await this.engine.insertIfAbsent(this.full(key), json, key.namespace, options?.expiry)
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
    const answer = await this.engine.compareAndSet(this.full(key), expected, json, key.namespace, options?.expiry)
    if (answer.ok) return { ok: true, entry: this.decoded(key, answer.entry) }
    return { ok: false, current: await this.entryOf(key, answer.current) }
  }

  async increment(key: StateKey<number, 'strong'>, delta = 1, options: IncrementOptions = {}): Promise<IncrementResult> {
    this.assertOpen()
    assertStrong(key, 'increment')
    const bounds = { min: options.min, max: options.max }
    const limits = counterLimits(key.namespace.schema)
    const answer = await this.engine.increment(this.full(key), delta, bounds, limits, key.namespace, options.expiry)
    if (answer.applied) return { applied: true, entry: this.decoded(key, answer.entry) }
    return { applied: false, current: await this.entryOf(key, answer.current) }
  }

  async decrement(key: StateKey<number, 'strong'>, delta = 1, options?: IncrementOptions): Promise<IncrementResult> {
    return this.increment(key, -delta, options)
  }

  async consume<T>(key: StateKey<T, 'strong'>, options: ConsumeOptions = {}): Promise<ConsumeResult<T>> {
    this.assertOpen()
    assertStrong(key, 'consume')
    const answer = await this.engine.consume(this.full(key), options.revision)
    if (answer.consumed) return { consumed: true, entry: (await this.entryOf(key, answer.entry))! }
    return { consumed: false, current: await this.entryOf(key, answer.current) }
  }

  async publish<E>(channel: Channel<E>, event: E): Promise<void> {
    this.assertOpen()
    await this.engine.publish(this.prefix + channel.path, encodeValue(channel.topic.schema, event, channel.path))
  }

  async subscribe<E>(channels: readonly Channel<E>[], listener: Listener<E>, options: SubscribeOptions = {}): Promise<Subscription> {
    this.assertOpen()
    if (channels.length === 0) throw new TypeError('AppState subscribe needs at least one channel')
    const { signal } = options
    const onAbort = () => background(subscription.end(), { name: 'app-state.unsubscribe-on-abort' })
    const subscription = new EngineSubscription<E>(
      new Map(channels.map((channel) => [this.prefix + channel.path, channel])),
      listener,
      this.onListenerError,
      (ended) => {
        this.subscriptions.delete(ended as EngineSubscription<unknown>)
        signal?.removeEventListener('abort', onAbort)
      },
    )
    if (signal?.aborted) {
      await subscription.end()
      return subscription
    }
    this.subscriptions.add(subscription as EngineSubscription<unknown>)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await subscription.start(this.engine)
    } catch (error) {
      await subscription.end()
      throw error
    }
    return subscription
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.subscriptions].map((subscription) => subscription.end()))
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('This AppState is closed')
  }

  private full(key: StateKey<unknown>): string {
    return this.prefix + key.path
  }

  /** An entry the engine just stored from a value this layer validated. */
  private decoded<T>(key: StateKey<T>, stored: StoredEntry): Entry<T> {
    return { value: decodeValue(key.namespace.schema, stored.json), revision: stored.revision, expiresAt: stored.expiresAt }
  }

  /**
   * The entry a caller gets: a fresh, validated copy. A value its schema now
   * rejects is a miss in an eventual namespace (a cache fetches it again) and
   * an error in a strong one.
   */
  private async entryOf<T>(key: StateKey<T>, stored: StoredEntry | null): Promise<Entry<T> | null> {
    if (!stored) return null
    try {
      return this.decoded(key, stored)
    } catch (error) {
      if (key.namespace.consistency === 'strong') {
        throw new Error(`AppState ${key.path} holds a value its schema rejects`, { cause: error })
      }
      await this.engine.remove(this.full(key))
      return null
    }
  }
}
