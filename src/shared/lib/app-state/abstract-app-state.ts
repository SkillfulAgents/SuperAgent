/**
 * AppState: the typed rules every deployment shares, over storage a subclass
 * supplies. This class validates and encodes values as JSON (so a caller that
 * changes what it read changes only its copy), checks strong-only operations,
 * and delivers events to listeners after `publish` resolved.
 *
 * A subclass implements the protected operations on full keys and encoded
 * values. Each one must be decided in one atomic step at the authority: in one
 * synchronous turn of the process that owns the entries, or in one call to a
 * remote authority (a Durable Object, Redis) that runs it as one transaction.
 * Never build one from a read and a write that cross the network.
 */
import { background } from '@shared/lib/background'
import type {
  AppStateScope,
  AppStateStore,
  AppStatePubSub,
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
} from './contract'
import { assertStrong, counterLimits, decodeValue, encodeValue, scopePrefix } from './definitions'

/** What deciding a write needs of its key's namespace. */
export type KeyPolicy = Pick<Namespace<unknown>, 'name' | 'consistency' | 'expiry'>

/** One stored entry: validated JSON, a revision never issued twice, its expiry. */
export interface StoredEntry {
  readonly json: string
  readonly revision: Revision
  readonly expiresAt: number | null
}

export interface CounterBounds {
  readonly min?: number
  readonly max?: number
}

export type StoredInsert = { inserted: true; entry: StoredEntry } | { inserted: false; current: StoredEntry }
export type StoredCompareAndSet = { ok: true; entry: StoredEntry } | { ok: false; current: StoredEntry | null }
export type StoredConsume = { consumed: true; entry: StoredEntry } | { consumed: false; current: StoredEntry | null }
export type StoredIncrement = { applied: true; entry: StoredEntry } | { applied: false; current: StoredEntry | null }

/** Receives each event of the channels it listens to, as the full channel and the encoded event. */
export type EventSink = (fullChannel: string, json: string) => void

export interface AppStateOptions {
  /** Receives a listener's failure instead of it being reported as failed background work. */
  onListenerError?: (error: unknown, channel: Channel<unknown>) => void
}

export abstract class AppState implements AppStateStore, AppStatePubSub {
  private readonly prefix: string
  private readonly subscriptions = new Set<ScopedSubscription<unknown>>()
  private readonly onListenerError: AppStateOptions['onListenerError']
  private closed = false

  constructor(
    readonly scope: AppStateScope,
    options: AppStateOptions = {},
  ) {
    this.prefix = scopePrefix(scope)
    this.onListenerError = options.onListenerError
  }

  /** The live entries, in the order of `fullKeys`; an expired one reads as missing. */
  protected abstract readEntries(fullKeys: readonly string[]): Promise<(StoredEntry | null)[]>
  protected abstract writeEntry(fullKey: string, json: string, policy: KeyPolicy, expiry?: Expiry): Promise<StoredEntry>
  protected abstract removeEntry(fullKey: string): Promise<void>
  protected abstract insertEntry(fullKey: string, json: string, policy: KeyPolicy, expiry?: Expiry): Promise<StoredInsert>
  protected abstract compareAndSetEntry(
    fullKey: string,
    expected: Revision | null,
    json: string,
    policy: KeyPolicy,
    expiry?: Expiry,
  ): Promise<StoredCompareAndSet>
  /**
   * Adds `delta` to the number stored under the key (0 when missing). A result past
   * `bounds` is refused; one past `limits`, what the counter's schema accepts, throws.
   * Either way nothing is stored.
   */
  protected abstract incrementEntry(
    fullKey: string,
    delta: number,
    bounds: CounterBounds,
    limits: CounterBounds,
    policy: KeyPolicy,
    expiry?: Expiry,
  ): Promise<StoredIncrement>
  /** Removes the entry if it is live (and, given a revision, still that revision). */
  protected abstract consumeEntry(fullKey: string, revision?: Revision): Promise<StoredConsume>
  /** Hands the event to every sink of the channel; resolves before any of them acts on it. */
  protected abstract publishEvent(fullChannel: string, json: string): Promise<void>
  /** Starts handing the channels' events to `sink`; the returned function stops it. */
  protected abstract listen(fullChannels: readonly string[], sink: EventSink): Promise<() => Promise<void>>

  async get<T>(key: StateKey<T>): Promise<Entry<T> | null> {
    this.assertOpen()
    const [stored] = await this.readEntries([this.full(key)])
    return this.entryOf(key, stored ?? null)
  }

  async getMany<T>(keys: readonly StateKey<T>[]): Promise<(Entry<T> | null)[]> {
    this.assertOpen()
    const stored = await this.readEntries(keys.map((key) => this.full(key)))
    return Promise.all(keys.map((key, i) => this.entryOf(key, stored[i] ?? null)))
  }

  async set<T>(key: StateKey<T>, value: T, options?: WriteOptions): Promise<Entry<T>> {
    this.assertOpen()
    const json = encodeValue(key.namespace.schema, value, key.path)
    return this.decoded(key, await this.writeEntry(this.full(key), json, key.namespace, options?.expiry))
  }

  async delete<T>(key: StateKey<T>): Promise<void> {
    this.assertOpen()
    await this.removeEntry(this.full(key))
  }

  async insertIfAbsent<T>(key: StateKey<T, 'strong'>, value: T, options?: WriteOptions): Promise<InsertResult<T>> {
    this.assertOpen()
    assertStrong(key, 'insertIfAbsent')
    const json = encodeValue(key.namespace.schema, value, key.path)
    const answer = await this.insertEntry(this.full(key), json, key.namespace, options?.expiry)
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
    const answer = await this.compareAndSetEntry(this.full(key), expected, json, key.namespace, options?.expiry)
    if (answer.ok) return { ok: true, entry: this.decoded(key, answer.entry) }
    return { ok: false, current: await this.entryOf(key, answer.current) }
  }

  async increment(key: StateKey<number, 'strong'>, delta = 1, options: IncrementOptions = {}): Promise<IncrementResult> {
    this.assertOpen()
    assertStrong(key, 'increment')
    if (!Number.isSafeInteger(delta)) throw new RangeError(`AppState increment of ${key.path}: the delta is a safe integer`)
    const bounds = { min: options.min, max: options.max }
    const limits = counterLimits(key.namespace.schema)
    const answer = await this.incrementEntry(this.full(key), delta, bounds, limits, key.namespace, options.expiry)
    if (answer.applied) return { applied: true, entry: this.decoded(key, answer.entry) }
    return { applied: false, current: await this.entryOf(key, answer.current) }
  }

  async decrement(key: StateKey<number, 'strong'>, delta = 1, options?: IncrementOptions): Promise<IncrementResult> {
    return this.increment(key, -delta, options)
  }

  async consume<T>(key: StateKey<T, 'strong'>, options: ConsumeOptions = {}): Promise<ConsumeResult<T>> {
    this.assertOpen()
    assertStrong(key, 'consume')
    const answer = await this.consumeEntry(this.full(key), options.revision)
    if (answer.consumed) return { consumed: true, entry: (await this.entryOf(key, answer.entry))! }
    return { consumed: false, current: await this.entryOf(key, answer.current) }
  }

  async publish<E>(channel: Channel<E>, event: E): Promise<void> {
    this.assertOpen()
    await this.publishEvent(this.prefix + channel.path, encodeValue(channel.topic.schema, event, channel.path))
  }

  async subscribe<E>(channels: readonly Channel<E>[], listener: Listener<E>, options: SubscribeOptions = {}): Promise<Subscription> {
    this.assertOpen()
    if (channels.length === 0) throw new TypeError('AppState subscribe needs at least one channel')
    const { signal } = options
    const onAbort = () => background(subscription.end(), { name: 'app-state.unsubscribe-on-abort' })
    const subscription = new ScopedSubscription<E>(
      new Map(channels.map((channel) => [this.prefix + channel.path, channel])),
      listener,
      this.onListenerError,
      (ended) => {
        this.subscriptions.delete(ended as ScopedSubscription<unknown>)
        signal?.removeEventListener('abort', onAbort)
      },
    )
    if (signal?.aborted) {
      await subscription.end()
      return subscription
    }
    this.subscriptions.add(subscription as ScopedSubscription<unknown>)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await subscription.start((fullChannels, sink) => this.listen(fullChannels, sink))
    } catch (error) {
      await subscription.end()
      throw error
    }
    return subscription
  }

  /** Ends this instance's subscriptions and releases its connections. Stored state stays. */
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

  /** An entry just stored from a value this class validated. */
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
      await this.removeEntry(this.full(key))
      return null
    }
  }
}

class ScopedSubscription<E> implements Subscription {
  private active = true
  private stop: (() => Promise<void>) | null = null

  constructor(
    private readonly channels: ReadonlyMap<string, Channel<E>>,
    private readonly listener: Listener<E>,
    private readonly onListenerError: AppStateOptions['onListenerError'],
    private readonly onEnd: (subscription: ScopedSubscription<E>) => void,
  ) {}

  async start(listen: (fullChannels: readonly string[], sink: EventSink) => Promise<() => Promise<void>>): Promise<void> {
    const stop = await listen([...this.channels.keys()], (fullChannel, json) => this.deliver(fullChannel, json))
    // Ended while the subclass was setting it up.
    if (!this.active) await stop()
    else this.stop = stop
  }

  private deliver(fullChannel: string, json: string): void {
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
