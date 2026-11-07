/**
 * The AppState contract: keyed state and live events shared by every process
 * that serves one tenant. Desktop and single-tenant web keep it in this
 * process's memory (`createLocalAppState`); a deployment that serves a tenant
 * from many short-lived processes installs a remote implementation at its
 * entry point. Application code is the same for both. The `AppState` class
 * (abstract-app-state.ts) implements both halves over storage a subclass
 * supplies; docs/app-state.md describes what a subclass must guarantee.
 */
import type { z } from 'zod'

/**
 * Declared per namespace, not per write. `strong`: reads are authoritative and
 * the conditional operations are atomic in the backend; for coordination
 * (claims, counters, pending flows). `eventual`: a read may miss or be stale
 * within the namespace's TTL; only for disposable caches a process can fetch
 * again, so only plain get/set/delete are offered.
 */
export type Consistency = 'strong' | 'eventual'

/**
 * What one AppState instance serves, fixed when it is created. Every key and
 * channel is prefixed `gamut:v1:{deploymentId}:tenant:{tenantId}:`; an
 * instance never serves another tenant, so a request's tenant is never swapped
 * into a shared global.
 */
export interface AppStateScope {
  readonly deploymentId: string
  readonly tenantId: string
}

declare const revisionBrand: unique symbol

/**
 * Identifies one write of one key. Opaque: hand it back to a conditional
 * operation, never parse or order it. A revision is never issued twice, so one
 * read before a key was deleted or expired does not match the key written
 * again afterwards.
 */
export type Revision = string & { readonly [revisionBrand]: true }

/**
 * A namespace's expiry. Expiry is when reads stop returning an entry (even if
 * the backend has not removed it yet); it runs nothing.
 */
export interface ExpiryPolicy {
  /** How long a new entry lives. null: until it is deleted (strong namespaces only). */
  readonly ttlMs: number | null
  /**
   * What a write to a live entry does to its expiry: `keep` the original one
   * (a fixed window, an absolute deadline) or `reset` it to `ttlMs` from the
   * write (an idle lifetime).
   */
  readonly onUpdate: 'keep' | 'reset'
}

/**
 * One write's expiry, instead of the namespace policy. `keep`: the live
 * entry's (a new entry gets `ttlMs` from now). `reset`: the namespace's
 * `ttlMs` from now. `never`: no expiry (strong namespaces only). `{ ttlMs }`:
 * that long from now. `{ at }`: that epoch-ms instant, to carry an expiry
 * decided earlier (a key set's original download time).
 */
export type Expiry = 'keep' | 'reset' | 'never' | { readonly ttlMs: number } | { readonly at: number }

export interface Namespace<T, C extends Consistency = Consistency> {
  readonly kind: 'namespace'
  /** `cache:oidc-jwks`: lowercase segments joined by `:`; `events:` is reserved for topics. */
  readonly name: string
  readonly consistency: C
  /** Validates every value written and read. It must not transform: a parsed value parses to itself. */
  readonly schema: z.ZodType<T>
  readonly expiry: ExpiryPolicy
  /**
   * The key for these parts. Each part is encoded and the name ends unambiguously,
   * so `key('a:b')` and `key('a', 'b')` differ, and no other namespace's key is the same path.
   */
  key(...parts: string[]): StateKey<T, C>
}

export interface StateKey<T, C extends Consistency = Consistency> {
  readonly namespace: Namespace<T, C>
  /** The key below the scope prefix: `{namespace}/{encoded parts joined by ':'}`. */
  readonly path: string
}

export interface Entry<T> {
  /** A copy: changing it changes nothing stored. */
  readonly value: T
  readonly revision: Revision
  /** Epoch ms from which reads no longer return the entry; null: no expiry. */
  readonly expiresAt: number | null
}

export interface WriteOptions {
  readonly expiry?: Expiry
}

export interface IncrementOptions extends WriteOptions {
  /** Refuse the change when the result would be below this. */
  readonly min?: number
  /** Refuse the change when the result would be above this. */
  readonly max?: number
}

export interface ConsumeOptions {
  /** Consume only while the entry is still this write. */
  readonly revision?: Revision
}

export type InsertResult<T> =
  | { readonly inserted: true; readonly entry: Entry<T> }
  | { readonly inserted: false; readonly current: Entry<T> }

export type CompareAndSetResult<T> =
  | { readonly ok: true; readonly entry: Entry<T> }
  | { readonly ok: false; readonly current: Entry<T> | null }

export type ConsumeResult<T> =
  | { readonly consumed: true; readonly entry: Entry<T> }
  | { readonly consumed: false; readonly current: Entry<T> | null }

export type IncrementResult =
  | { readonly applied: true; readonly entry: Entry<number> }
  | { readonly applied: false; readonly current: Entry<number> | null }

/**
 * Keyed state. Every operation is one backend operation: the conditional ones
 * decide and write atomically, which a `get` followed by a `set` does not.
 * A missing and an expired key are the same: absent.
 */
export interface AppStateStore {
  get<T>(key: StateKey<T>): Promise<Entry<T> | null>
  /** One round trip; the result is in the order of `keys`. */
  getMany<T>(keys: readonly StateKey<T>[]): Promise<(Entry<T> | null)[]>
  /** Writes unconditionally, with a new revision. Expiry follows the namespace's `onUpdate` unless `options.expiry` says otherwise. */
  set<T>(key: StateKey<T>, value: T, options?: WriteOptions): Promise<Entry<T>>
  delete<T>(key: StateKey<T>): Promise<void>

  /** Writes only when the key is absent; otherwise returns what it holds. */
  insertIfAbsent<T>(key: StateKey<T, 'strong'>, value: T, options?: WriteOptions): Promise<InsertResult<T>>
  /**
   * Writes only when the key still holds the `expected` write (null: only when
   * absent); otherwise returns what it holds. A revision read before the key
   * was deleted or expired never matches again.
   */
  compareAndSet<T>(
    key: StateKey<T, 'strong'>,
    expected: Revision | null,
    value: T,
    options?: WriteOptions,
  ): Promise<CompareAndSetResult<T>>
  /**
   * Adds `delta` (a safe integer, default 1) to an integer counter; an absent
   * counter starts at 0. With `min`/`max`, a change that would leave the bounds
   * is refused and the counter keeps its value and expiry.
   */
  increment(key: StateKey<number, 'strong'>, delta?: number, options?: IncrementOptions): Promise<IncrementResult>
  /** `increment` by `-delta`. */
  decrement(key: StateKey<number, 'strong'>, delta?: number, options?: IncrementOptions): Promise<IncrementResult>
  /** Deletes the entry and returns it, once: of competing calls exactly one consumes it. */
  consume<T>(key: StateKey<T, 'strong'>, options?: ConsumeOptions): Promise<ConsumeResult<T>>
}

export interface Topic<E> {
  readonly kind: 'topic'
  /** `events:meeting:roster`: starts `events:`, then lowercase segments joined by `:`. */
  readonly name: string
  /** Validates every event published and delivered. It must not transform. */
  readonly schema: z.ZodType<E>
  /** The channel for these parts, encoded as a namespace key is. */
  channel(...parts: string[]): Channel<E>
}

export interface Channel<E> {
  readonly topic: Topic<E>
  /** The channel below the scope prefix: `{topic}/{encoded parts joined by ':'}`. */
  readonly path: string
}

/** Gets its own copy of the event, and the channel object it subscribed with. */
export type Listener<E> = (event: E, channel: Channel<E>) => void | Promise<void>

export interface SubscribeOptions {
  /** Ends the subscription when it aborts, also while `subscribe` is still setting it up. */
  readonly signal?: AbortSignal
}

export interface Subscription {
  /** Once this resolves the listener is not called again. Idempotent. */
  unsubscribe(): Promise<void>
}

/**
 * Live, best-effort notifications. `publish` resolves once the backend has
 * accepted the event, not once listeners ran (and it does not wait for their
 * work). Nothing is retained: a subscriber that was not subscribed, or that
 * reconnects after a gap, re-reads the authoritative state instead. Not a job
 * queue: work that must happen goes to its owner directly.
 */
export interface AppStatePubSub {
  publish<E>(channel: Channel<E>, event: E): Promise<void>
  /**
   * Calls `listener` for each event published on any of `channels` after this
   * resolves, until the subscription ends. No order is promised across
   * backends.
   */
  subscribe<E>(channels: readonly Channel<E>[], listener: Listener<E>, options?: SubscribeOptions): Promise<Subscription>
}
