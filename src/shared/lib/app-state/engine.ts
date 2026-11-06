/**
 * AppState's raw operations: full keys, values already encoded as JSON. The typed
 * AppState (engine-app-state.ts) validates and encodes, then hands each operation
 * to an engine, which decides it in one step. The local engine decides in this
 * process; a deployment can supply one that decides elsewhere (another process,
 * a Durable Object) and answers over the network.
 */
import type { Consistency, Expiry, ExpiryPolicy, Revision } from './contract'

/** What deciding a write needs of its key's namespace. */
export interface KeyPolicy {
  readonly name: string
  readonly consistency: Consistency
  readonly expiry: ExpiryPolicy
}

/** One stored entry: validated JSON, a revision never issued twice, its expiry. */
export interface StoredEntry {
  readonly json: string
  readonly revision: Revision
  readonly expiresAt: number | null
}

export type InsertAnswer = { inserted: true; entry: StoredEntry } | { inserted: false; current: StoredEntry }
export type CompareAndSetAnswer = { ok: true; entry: StoredEntry } | { ok: false; current: StoredEntry | null }
export type ConsumeAnswer = { consumed: true; entry: StoredEntry } | { consumed: false; current: StoredEntry | null }
export type IncrementAnswer = { applied: true; entry: StoredEntry } | { applied: false; current: StoredEntry | null }

export interface IncrementBounds {
  readonly min?: number
  readonly max?: number
}

/** Receives the events of the channels it subscribed to. */
export interface EngineSubscriber {
  deliver(fullChannel: string, json: string): void
}

type Answer<T> = T | Promise<T>

export interface AppStateEngine {
  /** The live entry; an expired one reads as missing. */
  read(fullKey: string): Answer<StoredEntry | null>
  readMany(fullKeys: readonly string[]): Answer<(StoredEntry | null)[]>
  write(fullKey: string, json: string, policy: KeyPolicy, expiry?: Expiry): Answer<StoredEntry>
  remove(fullKey: string): Answer<void>
  insertIfAbsent(fullKey: string, json: string, policy: KeyPolicy, expiry?: Expiry): Answer<InsertAnswer>
  compareAndSet(fullKey: string, expected: Revision | null, json: string, policy: KeyPolicy, expiry?: Expiry): Answer<CompareAndSetAnswer>
  /**
   * Adds `delta` to the number stored under the key (0 when missing). A result past
   * `bounds` is refused; one past `limits`, what the namespace schema accepts, throws.
   * Either way nothing is stored.
   */
  increment(
    fullKey: string,
    delta: number,
    bounds: IncrementBounds,
    limits: IncrementBounds,
    policy: KeyPolicy,
    expiry?: Expiry,
  ): Answer<IncrementAnswer>
  /** Removes the entry if it is live (and, given a revision, still that revision). */
  consume(fullKey: string, revision?: Revision): Answer<ConsumeAnswer>
  /** Hands the event to every subscriber of the channel; resolves before any of them acts on it. */
  publish(fullChannel: string, json: string): Answer<void>
  /** Starts delivering the channels' events; the returned function stops it. */
  subscribe(fullChannels: readonly string[], subscriber: EngineSubscriber): Answer<() => void | Promise<void>>
}
