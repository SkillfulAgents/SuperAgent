/**
 * The org's AppState object: the authority CloudflareAppState (cloudflare-app-state.ts) sends each
 * operation to. It decides each keyed operation in one SQLite transaction (`transactionSync`), so
 * an operation is never a read and a write split by the network, and it carries events to the
 * sockets that subscribed. On its own here, apart from what the rest of the org loads: a script
 * that holds only this object stays small.
 */
import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectState, WorkerWebSocket } from 'cloudflare:workers'
import type { Expiry, Namespace, Revision } from '@shared/lib/app-state'
import { resolveExpiry } from '@shared/lib/app-state/definitions'
import type { Env } from './index'
import { restartIfOlder } from './object-version'

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

export interface StoredEntry {
  readonly json: string
  readonly revision: Revision
  readonly expiresAt: number | null
}

export interface CounterBounds {
  readonly min?: number
  readonly max?: number
}

export type EventSink = (fullChannel: string, json: string) => void

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
