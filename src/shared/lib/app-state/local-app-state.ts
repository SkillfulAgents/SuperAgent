/**
 * AppState in this process's memory: the implementation for a host that serves
 * its tenant from one long-running process (desktop, single-tenant web). Every
 * operation is decided in one synchronous turn over the process's entries, so
 * it is atomic.
 */
import { randomBytes } from 'node:crypto'
import {
  AppState,
  type CounterBounds,
  type EventSink,
  type KeyPolicy,
  type StoredCompareAndSet,
  type StoredConsume,
  type StoredEntry,
  type StoredIncrement,
  type StoredInsert,
} from './abstract-app-state'
import type { AppStateScope, Channel, Expiry, Revision } from './contract'
import { resolveExpiry } from './definitions'

/** The scope of a host that serves one tenant from one process. */
export const LOCAL_APP_STATE_SCOPE: AppStateScope = Object.freeze({ deploymentId: 'local', tenantId: 'local' })

/** The fewest writes between two sweeps of expired entries. */
const SWEEP_AFTER_WRITES = 1_000

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
  private readonly sinks = new Map<string, Set<EventSink>>()
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
  read(fullKey: string): StoredEntry | null {
    const entry = this.entries.get(fullKey)
    if (!entry) return null
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(fullKey)
      return null
    }
    return entry
  }

  write(fullKey: string, json: string, policy: KeyPolicy, expiry: Expiry | undefined, current: StoredEntry | null): StoredEntry {
    const expiresAt = resolveExpiry(policy, expiry, current ?? undefined, this.now())
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

  addSink(fullChannel: string, sink: EventSink): void {
    let sinks = this.sinks.get(fullChannel)
    if (!sinks) {
      sinks = new Set()
      this.sinks.set(fullChannel, sinks)
    }
    sinks.add(sink)
  }

  removeSink(fullChannel: string, sink: EventSink): void {
    const sinks = this.sinks.get(fullChannel)
    if (!sinks) return
    sinks.delete(sink)
    if (sinks.size === 0) this.sinks.delete(fullChannel)
  }

  /** Hands the event to every sink of the channel; each delivers it later. */
  publish(fullChannel: string, json: string): void {
    const sinks = this.sinks.get(fullChannel)
    if (!sinks) return
    for (const sink of [...sinks]) sink(fullChannel, json)
  }
}

export class LocalAppState extends AppState {
  constructor(
    scope: AppStateScope,
    private readonly backend: LocalAppStateBackend,
  ) {
    super(scope, { onListenerError: backend.onListenerError })
  }

  protected async readEntries(fullKeys: readonly string[]): Promise<(StoredEntry | null)[]> {
    return fullKeys.map((fullKey) => this.backend.read(fullKey))
  }

  protected async writeEntry(fullKey: string, json: string, policy: KeyPolicy, expiry?: Expiry): Promise<StoredEntry> {
    return this.backend.write(fullKey, json, policy, expiry, this.backend.read(fullKey))
  }

  protected async removeEntry(fullKey: string): Promise<void> {
    this.backend.remove(fullKey)
  }

  protected async insertEntry(fullKey: string, json: string, policy: KeyPolicy, expiry?: Expiry): Promise<StoredInsert> {
    const current = this.backend.read(fullKey)
    if (current) return { inserted: false, current }
    return { inserted: true, entry: this.backend.write(fullKey, json, policy, expiry, null) }
  }

  protected async compareAndSetEntry(
    fullKey: string,
    expected: Revision | null,
    json: string,
    policy: KeyPolicy,
    expiry?: Expiry,
  ): Promise<StoredCompareAndSet> {
    const current = this.backend.read(fullKey)
    if ((current?.revision ?? null) !== expected) return { ok: false, current }
    return { ok: true, entry: this.backend.write(fullKey, json, policy, expiry, current) }
  }

  protected async incrementEntry(
    fullKey: string,
    delta: number,
    bounds: CounterBounds,
    limits: CounterBounds,
    policy: KeyPolicy,
    expiry?: Expiry,
  ): Promise<StoredIncrement> {
    const current = this.backend.read(fullKey)
    const value = current ? (JSON.parse(current.json) as unknown) : 0
    if (typeof value !== 'number') throw new TypeError(`AppState counter ${fullKey} does not hold a number`)
    const next = value + delta
    if (!Number.isSafeInteger(next)) throw new RangeError(`AppState counter ${fullKey} would leave the safe integers`)
    if ((bounds.min !== undefined && next < bounds.min) || (bounds.max !== undefined && next > bounds.max)) {
      return { applied: false, current }
    }
    if ((limits.min !== undefined && next < limits.min) || (limits.max !== undefined && next > limits.max)) {
      throw new RangeError(`AppState counter ${fullKey}: ${next} is outside what its schema accepts`)
    }
    return { applied: true, entry: this.backend.write(fullKey, JSON.stringify(next), policy, expiry, current) }
  }

  protected async consumeEntry(fullKey: string, revision?: Revision): Promise<StoredConsume> {
    const current = this.backend.read(fullKey)
    if (!current || (revision !== undefined && current.revision !== revision)) return { consumed: false, current }
    this.backend.remove(fullKey)
    return { consumed: true, entry: current }
  }

  protected async publishEvent(fullChannel: string, json: string): Promise<void> {
    this.backend.publish(fullChannel, json)
  }

  protected async listen(fullChannels: readonly string[], sink: EventSink): Promise<() => Promise<void>> {
    for (const fullChannel of fullChannels) this.backend.addSink(fullChannel, sink)
    return async () => {
      for (const fullChannel of fullChannels) this.backend.removeSink(fullChannel, sink)
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
