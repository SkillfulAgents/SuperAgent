/**
 * AppState decided in this process: the engine for a host that serves its tenant
 * from one long-running process (desktop, single-tenant web). Each operation is
 * one synchronous step over an entry store, so it is atomic. The store is memory
 * by default; a deployment whose process keeps storage (a Durable Object's
 * SQLite) passes its own, and the same rules apply there.
 */
import { randomBytes } from 'node:crypto'
import type { AppState, AppStateScope, Channel, Expiry, Revision } from './contract'
import { resolveExpiry } from './definitions'
import { createAppState } from './engine-app-state'
import type {
  AppStateEngine,
  CompareAndSetAnswer,
  ConsumeAnswer,
  EngineSubscriber,
  IncrementAnswer,
  IncrementBounds,
  InsertAnswer,
  KeyPolicy,
  StoredEntry,
} from './engine'

/** The scope of a host that serves one tenant from one process. */
export const LOCAL_APP_STATE_SCOPE: AppStateScope = Object.freeze({ deploymentId: 'local', tenantId: 'local' })

/** The fewest writes between two sweeps of expired entries. */
const SWEEP_AFTER_WRITES = 1_000

/** Where the local engine keeps its entries. Synchronous, so each operation stays one step. */
export interface EntryStore {
  get(fullKey: string): StoredEntry | undefined
  put(fullKey: string, entry: StoredEntry): void
  delete(fullKey: string): void
  /** Removes every entry that expired at or before `now`. */
  deleteExpired(now: number): void
  /** Entries held, expired ones not yet swept included. */
  readonly size: number
}

export class MemoryEntryStore implements EntryStore {
  private readonly entries = new Map<string, StoredEntry>()

  get(fullKey: string): StoredEntry | undefined {
    return this.entries.get(fullKey)
  }

  put(fullKey: string, entry: StoredEntry): void {
    this.entries.set(fullKey, entry)
  }

  delete(fullKey: string): void {
    this.entries.delete(fullKey)
  }

  deleteExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.entries.delete(key)
    }
  }

  get size(): number {
    return this.entries.size
  }
}

export interface LocalAppStateBackendOptions {
  /** The clock expiry is measured against (epoch ms). */
  now?: () => number
  /** Where entries live; memory by default. */
  store?: EntryStore
  /** Receives a listener's failure instead of it being reported as failed background work. */
  onListenerError?: (error: unknown, channel: Channel<unknown>) => void
}

/**
 * What every LocalAppState of one process shares: the entries and listeners of
 * all scopes, under full keys. One per process; a test makes its own.
 */
export class LocalAppStateBackend implements AppStateEngine {
  readonly now: () => number
  readonly onListenerError: ((error: unknown, channel: Channel<unknown>) => void) | undefined
  private readonly store: EntryStore
  private readonly listeners = new Map<string, Set<EngineSubscriber>>()
  // Revisions are `{epoch}.{sequence}`: unique within the process, and a new
  // process (a new backend, even over a kept store) never issues one an old process did.
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
    this.store = options.store ?? new MemoryEntryStore()
    this.onListenerError = options.onListenerError
  }

  read(fullKey: string): StoredEntry | null {
    const entry = this.store.get(fullKey)
    if (!entry) return null
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.store.delete(fullKey)
      return null
    }
    return entry
  }

  readMany(fullKeys: readonly string[]): (StoredEntry | null)[] {
    return fullKeys.map((fullKey) => this.read(fullKey))
  }

  write(fullKey: string, json: string, policy: KeyPolicy, expiry?: Expiry): StoredEntry {
    return this.put(fullKey, json, policy, expiry, this.read(fullKey))
  }

  remove(fullKey: string): void {
    this.store.delete(fullKey)
  }

  insertIfAbsent(fullKey: string, json: string, policy: KeyPolicy, expiry?: Expiry): InsertAnswer {
    const current = this.read(fullKey)
    if (current) return { inserted: false, current }
    return { inserted: true, entry: this.put(fullKey, json, policy, expiry, null) }
  }

  compareAndSet(fullKey: string, expected: Revision | null, json: string, policy: KeyPolicy, expiry?: Expiry): CompareAndSetAnswer {
    const current = this.read(fullKey)
    if ((current?.revision ?? null) !== expected) return { ok: false, current }
    return { ok: true, entry: this.put(fullKey, json, policy, expiry, current) }
  }

  increment(fullKey: string, delta: number, bounds: IncrementBounds, policy: KeyPolicy, expiry?: Expiry): IncrementAnswer {
    if (!Number.isSafeInteger(delta)) throw new RangeError(`AppState increment of ${fullKey}: the delta is a safe integer`)
    const current = this.read(fullKey)
    const value = current ? (JSON.parse(current.json) as unknown) : 0
    if (typeof value !== 'number') throw new TypeError(`AppState counter ${fullKey} does not hold a number`)
    const next = value + delta
    if (!Number.isSafeInteger(next)) throw new RangeError(`AppState counter ${fullKey} would leave the safe integers`)
    if ((bounds.min !== undefined && next < bounds.min) || (bounds.max !== undefined && next > bounds.max)) {
      return { applied: false, current }
    }
    return { applied: true, entry: this.put(fullKey, JSON.stringify(next), policy, expiry, current) }
  }

  consume(fullKey: string, revision?: Revision): ConsumeAnswer {
    const current = this.read(fullKey)
    if (!current || (revision !== undefined && current.revision !== revision)) return { consumed: false, current }
    this.store.delete(fullKey)
    return { consumed: true, entry: current }
  }

  /** Hands the event to every subscriber of the channel; each delivers it later. */
  publish(fullChannel: string, json: string): void {
    const subscribers = this.listeners.get(fullChannel)
    if (!subscribers) return
    for (const subscriber of [...subscribers]) subscriber.deliver(fullChannel, json)
  }

  subscribe(fullChannels: readonly string[], subscriber: EngineSubscriber): () => void {
    for (const fullChannel of fullChannels) {
      let subscribers = this.listeners.get(fullChannel)
      if (!subscribers) {
        subscribers = new Set()
        this.listeners.set(fullChannel, subscribers)
      }
      subscribers.add(subscriber)
    }
    return () => {
      for (const fullChannel of fullChannels) {
        const subscribers = this.listeners.get(fullChannel)
        if (!subscribers) continue
        subscribers.delete(subscriber)
        if (subscribers.size === 0) this.listeners.delete(fullChannel)
      }
    }
  }

  /** Entries held, expired ones not yet swept included. */
  get entryCount(): number {
    return this.store.size
  }

  private put(fullKey: string, json: string, policy: KeyPolicy, expiry: Expiry | undefined, current: StoredEntry | null): StoredEntry {
    const now = this.now()
    const expiresAt = resolveExpiry(policy, expiry, current ?? undefined, now)
    const entry: StoredEntry = { json, revision: `${this.epoch}.${++this.sequence}` as Revision, expiresAt }
    this.store.put(fullKey, entry)
    if (--this.writesUntilSweep <= 0) this.sweep(now)
    return entry
  }

  private sweep(now: number): void {
    this.store.deleteExpired(now)
    this.writesUntilSweep = Math.max(SWEEP_AFTER_WRITES, this.store.size)
  }
}

export interface LocalAppStateOptions {
  scope?: AppStateScope
  /** The process's backend; a test passes its own to share one between scopes or move its clock. */
  backend?: LocalAppStateBackend
}

export function createLocalAppState(options: LocalAppStateOptions = {}): AppState {
  const backend = options.backend ?? new LocalAppStateBackend()
  return createAppState({ scope: options.scope ?? LOCAL_APP_STATE_SCOPE, engine: backend, onListenerError: backend.onListenerError })
}
