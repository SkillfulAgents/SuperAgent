/**
 * AppState in this process's memory: the implementation for a host that serves
 * its tenant from one long-running process (desktop, single-tenant web). It
 * keeps the remote contract: values are validated and stored as JSON, so a
 * caller that changes what it read changes only its copy; every operation is
 * async; listeners run after `publish` resolved.
 */
import { randomBytes } from 'node:crypto'
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
import { assertStrong, decodeValue, encodeValue, resolveExpiry, scopePrefix } from './definitions'

/** The scope of a host that serves one tenant from one process. */
export const LOCAL_APP_STATE_SCOPE: AppStateScope = Object.freeze({ deploymentId: 'local', tenantId: 'local' })

/** The fewest writes between two sweeps of expired entries. */
const SWEEP_AFTER_WRITES = 1_000

interface StoredEntry {
  readonly json: string
  readonly revision: Revision
  readonly expiresAt: number | null
}

export interface LocalAppStateBackendOptions {
  /** The clock expiry is measured against (epoch ms). */
  now?: () => number
  /** Receives a listener's failure instead of it being reported as failed background work. */
  onListenerError?: (error: unknown, channel: Channel<unknown>) => void
}

/**
 * What every LocalAppState of one process shares: the entries and listeners of
 * all scopes, under full keys. One per process; a test makes its own.
 */
export class LocalAppStateBackend {
  readonly now: () => number
  readonly onListenerError: ((error: unknown, channel: Channel<unknown>) => void) | undefined
  private readonly entries = new Map<string, StoredEntry>()
  private readonly listeners = new Map<string, Set<LocalSubscription<unknown>>>()
  // Revisions are `{epoch}.{sequence}`: unique within the process, and a new
  // process (a new backend) never issues one an old process did.
  private readonly epoch = randomBytes(8).toString('hex')
  private sequence = 0
  // Fixed when a sweep ends, so new keys cannot keep pushing the next sweep
  // away: a sweep runs after as many writes as entries it kept (at least
  // SWEEP_AFTER_WRITES), which keeps it amortized O(1) per write and bounds
  // what expired entries can pile up to about one sweep's worth of writes.
  private writesUntilSweep = SWEEP_AFTER_WRITES

  constructor(options: LocalAppStateBackendOptions = {}) {
    // Looked up at each call, so a test's fake Date applies.
    this.now = options.now ?? (() => Date.now())
    this.onListenerError = options.onListenerError
  }

  /** The live entry, forgetting it once it has expired. */
  read(fullKey: string): StoredEntry | undefined {
    const entry = this.entries.get(fullKey)
    if (!entry) return undefined
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(fullKey)
      return undefined
    }
    return entry
  }

  write(fullKey: string, json: string, expiresAt: number | null): StoredEntry {
    const entry: StoredEntry = { json, revision: `${this.epoch}.${++this.sequence}` as Revision, expiresAt }
    this.entries.set(fullKey, entry)
    if (--this.writesUntilSweep <= 0) this.sweep()
    return entry
  }

  remove(fullKey: string): void {
    this.entries.delete(fullKey)
  }

  /** Entries held, expired ones not yet swept included. */
  get entryCount(): number {
    return this.entries.size
  }

  private sweep(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.entries.delete(key)
    }
    this.writesUntilSweep = Math.max(SWEEP_AFTER_WRITES, this.entries.size)
  }

  addListener(fullChannel: string, subscription: LocalSubscription<unknown>): void {
    let subscriptions = this.listeners.get(fullChannel)
    if (!subscriptions) {
      subscriptions = new Set()
      this.listeners.set(fullChannel, subscriptions)
    }
    subscriptions.add(subscription)
  }

  removeListener(fullChannel: string, subscription: LocalSubscription<unknown>): void {
    const subscriptions = this.listeners.get(fullChannel)
    if (!subscriptions) return
    subscriptions.delete(subscription)
    if (subscriptions.size === 0) this.listeners.delete(fullChannel)
  }

  /** Hands the event to every subscription of the channel; each delivers it later. */
  publish(fullChannel: string, json: string): void {
    const subscriptions = this.listeners.get(fullChannel)
    if (!subscriptions) return
    for (const subscription of [...subscriptions]) subscription.deliver(fullChannel, json)
  }
}

class LocalSubscription<E> implements Subscription {
  private active = true

  constructor(
    private readonly backend: LocalAppStateBackend,
    private readonly channels: ReadonlyMap<string, Channel<E>>,
    private readonly listener: Listener<E>,
    private readonly onEnd: (subscription: LocalSubscription<E>) => void,
  ) {}

  start(): void {
    for (const fullChannel of this.channels.keys()) this.backend.addListener(fullChannel, this as LocalSubscription<unknown>)
  }

  deliver(fullChannel: string, json: string): void {
    const channel = this.channels.get(fullChannel)
    if (!channel) return
    const onError = this.backend.onListenerError
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

  end(): void {
    if (!this.active) return
    this.active = false
    for (const fullChannel of this.channels.keys()) this.backend.removeListener(fullChannel, this as LocalSubscription<unknown>)
    this.onEnd(this)
  }

  async unsubscribe(): Promise<void> {
    this.end()
  }
}

class LocalAppState implements AppState {
  private readonly prefix: string
  private readonly subscriptions = new Set<LocalSubscription<unknown>>()
  private closed = false

  constructor(
    readonly scope: AppStateScope,
    private readonly backend: LocalAppStateBackend,
  ) {
    this.prefix = scopePrefix(scope)
  }

  async get<T>(key: StateKey<T>): Promise<Entry<T> | null> {
    this.assertOpen()
    return this.entryOf(key, this.backend.read(this.full(key)))
  }

  async getMany<T>(keys: readonly StateKey<T>[]): Promise<(Entry<T> | null)[]> {
    this.assertOpen()
    return keys.map((key) => this.entryOf(key, this.backend.read(this.full(key))))
  }

  async set<T>(key: StateKey<T>, value: T, options?: WriteOptions): Promise<Entry<T>> {
    this.assertOpen()
    const json = encodeValue(key.namespace.schema, value, key.path)
    return this.write(key, json, options, this.backend.read(this.full(key)))
  }

  async delete<T>(key: StateKey<T>): Promise<void> {
    this.assertOpen()
    this.backend.remove(this.full(key))
  }

  async insertIfAbsent<T>(key: StateKey<T, 'strong'>, value: T, options?: WriteOptions): Promise<InsertResult<T>> {
    this.assertOpen()
    assertStrong(key, 'insertIfAbsent')
    const json = encodeValue(key.namespace.schema, value, key.path)
    const current = this.entryOf(key, this.backend.read(this.full(key)))
    if (current) return { inserted: false, current }
    return { inserted: true, entry: this.write(key, json, options, undefined) }
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
    const stored = this.backend.read(this.full(key))
    if ((stored?.revision ?? null) !== expected) return { ok: false, current: this.entryOf(key, stored) }
    return { ok: true, entry: this.write(key, json, options, stored) }
  }

  async increment(key: StateKey<number, 'strong'>, delta = 1, options: IncrementOptions = {}): Promise<IncrementResult> {
    this.assertOpen()
    assertStrong(key, 'increment')
    if (!Number.isSafeInteger(delta)) throw new RangeError(`AppState increment of ${key.path}: the delta is a safe integer`)
    const stored = this.backend.read(this.full(key))
    const current = this.entryOf(key, stored)
    const next = (current?.value ?? 0) + delta
    if (!Number.isSafeInteger(next)) throw new RangeError(`AppState counter ${key.path} would leave the safe integers`)
    if ((options.min !== undefined && next < options.min) || (options.max !== undefined && next > options.max)) {
      return { applied: false, current }
    }
    const json = encodeValue(key.namespace.schema, next, key.path)
    return { applied: true, entry: this.write(key, json, options, stored) }
  }

  async decrement(key: StateKey<number, 'strong'>, delta = 1, options?: IncrementOptions): Promise<IncrementResult> {
    return this.increment(key, -delta, options)
  }

  async consume<T>(key: StateKey<T, 'strong'>, options: ConsumeOptions = {}): Promise<ConsumeResult<T>> {
    this.assertOpen()
    assertStrong(key, 'consume')
    const current = this.entryOf(key, this.backend.read(this.full(key)))
    if (!current || (options.revision !== undefined && current.revision !== options.revision)) {
      return { consumed: false, current }
    }
    this.backend.remove(this.full(key))
    return { consumed: true, entry: current }
  }

  async publish<E>(channel: Channel<E>, event: E): Promise<void> {
    this.assertOpen()
    this.backend.publish(this.prefix + channel.path, encodeValue(channel.topic.schema, event, channel.path))
  }

  async subscribe<E>(channels: readonly Channel<E>[], listener: Listener<E>, options: SubscribeOptions = {}): Promise<Subscription> {
    this.assertOpen()
    if (channels.length === 0) throw new TypeError('AppState subscribe needs at least one channel')
    const { signal } = options
    const onAbort = () => subscription.end()
    const subscription = new LocalSubscription<E>(
      this.backend,
      new Map(channels.map((channel) => [this.prefix + channel.path, channel])),
      listener,
      (ended) => {
        this.subscriptions.delete(ended as LocalSubscription<unknown>)
        signal?.removeEventListener('abort', onAbort)
      },
    )
    if (signal?.aborted) {
      subscription.end()
      return subscription
    }
    subscription.start()
    this.subscriptions.add(subscription as LocalSubscription<unknown>)
    signal?.addEventListener('abort', onAbort, { once: true })
    return subscription
  }

  async close(): Promise<void> {
    this.closed = true
    for (const subscription of [...this.subscriptions]) subscription.end()
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('This AppState is closed')
  }

  private full(key: StateKey<unknown>): string {
    return this.prefix + key.path
  }

  private write<T>(key: StateKey<T>, json: string, options: WriteOptions | undefined, current: StoredEntry | undefined): Entry<T> {
    const expiresAt = resolveExpiry(key.namespace, options?.expiry, current, this.backend.now())
    const stored = this.backend.write(this.full(key), json, expiresAt)
    return { value: decodeValue(key.namespace.schema, stored.json), revision: stored.revision, expiresAt }
  }

  /**
   * The entry a caller gets: a fresh, validated copy. A value its schema now
   * rejects is a miss in an eventual namespace (a cache fetches it again) and
   * an error in a strong one.
   */
  private entryOf<T>(key: StateKey<T>, stored: StoredEntry | undefined): Entry<T> | null {
    if (!stored) return null
    try {
      return { value: decodeValue(key.namespace.schema, stored.json), revision: stored.revision, expiresAt: stored.expiresAt }
    } catch (error) {
      if (key.namespace.consistency === 'strong') {
        throw new Error(`AppState ${key.path} holds a value its schema rejects`, { cause: error })
      }
      this.backend.remove(this.full(key))
      return null
    }
  }
}

export interface LocalAppStateOptions {
  scope?: AppStateScope
  /** The process's backend; a test passes its own to share one between scopes or move its clock. */
  backend?: LocalAppStateBackend
}

export function createLocalAppState(options: LocalAppStateOptions = {}): AppState {
  return new LocalAppState(options.scope ?? LOCAL_APP_STATE_SCOPE, options.backend ?? new LocalAppStateBackend())
}
