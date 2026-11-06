/**
 * The org's AppState (app-state/contract.ts), one object per org: where the state lives. Each
 * call runs alone and its SQL is synchronous, so a conditional write decides and writes with
 * nothing in between: claims, counters and one-time flows are atomic here. Clients validate and
 * encode values (cloudflare-app-state.ts); this object keeps their JSON, a revision, and the expiry
 * SuperAgent's own `resolveExpiry` decides.
 *
 * Live events go out over WebSockets: every subscription holds one socket here, and a publish is
 * sent to each socket subscribed to its channel. The sockets hibernate with their channels
 * attached, so the object can be evicted between events.
 */
import { DurableObject } from 'cloudflare:workers'
import type { DurableObjectState, SqlStorage, WorkerWebSocket } from 'cloudflare:workers'
import type { Consistency, Expiry, ExpiryPolicy, Namespace } from '@shared/lib/app-state/contract'
import { resolveExpiry } from '@shared/lib/app-state/definitions'
import type { Env } from './index'

/** What a write needs of its key's namespace; the client sends it with each write. */
export interface KeyPolicy {
  name: string
  consistency: Consistency
  expiry: ExpiryPolicy
}

/** One stored entry: the client's validated JSON, a revision never issued twice, its expiry. */
export interface StoredEntry {
  json: string
  revision: string
  expiresAt: number | null
}

export type InsertAnswer = { inserted: true; entry: StoredEntry } | { inserted: false; current: StoredEntry }
export type CompareAndSetAnswer = { ok: true; entry: StoredEntry } | { ok: false; current: StoredEntry | null }
export type ConsumeAnswer = { consumed: true; entry: StoredEntry } | { consumed: false; current: StoredEntry | null }
export type IncrementAnswer = { applied: true; entry: StoredEntry } | { applied: false; current: StoredEntry | null }

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

/** Lapsed rows are already invisible; deleting them only reclaims space, at most this often. */
const SWEEP_EVERY_MS = 60_000

export class AppStateDurableObject extends DurableObject<Env> {
  private readonly sql: SqlStorage
  // Revisions are `{epoch}.{sequence}`: a new instance of this object never issues one an old instance did.
  private readonly epoch = crypto.randomUUID()
  private sequence = 0
  private sweptAt = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec('CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, json TEXT NOT NULL, revision TEXT NOT NULL, expires_at INTEGER)')
  }

  get(key: string): StoredEntry | null {
    return this.read(key)
  }

  getMany(keys: string[]): Array<StoredEntry | null> {
    return keys.map((key) => this.read(key))
  }

  set(key: string, json: string, policy: KeyPolicy, expiry?: Expiry): StoredEntry {
    return this.write(key, json, policy, expiry, this.read(key))
  }

  delete(key: string): void {
    this.sql.exec('DELETE FROM app_state WHERE key = ?', key)
  }

  insertIfAbsent(key: string, json: string, policy: KeyPolicy, expiry?: Expiry): InsertAnswer {
    const current = this.read(key)
    if (current) return { inserted: false, current }
    return { inserted: true, entry: this.write(key, json, policy, expiry, null) }
  }

  compareAndSet(key: string, expected: string | null, json: string, policy: KeyPolicy, expiry?: Expiry): CompareAndSetAnswer {
    const current = this.read(key)
    if ((current?.revision ?? null) !== expected) return { ok: false, current }
    return { ok: true, entry: this.write(key, json, policy, expiry, current) }
  }

  increment(key: string, delta: number, bounds: { min?: number; max?: number }, policy: KeyPolicy, expiry?: Expiry): IncrementAnswer {
    if (!Number.isSafeInteger(delta)) throw new RangeError(`AppState increment of ${key}: the delta is a safe integer`)
    const current = this.read(key)
    const value = current ? (JSON.parse(current.json) as unknown) : 0
    if (typeof value !== 'number') throw new TypeError(`AppState counter ${key} does not hold a number`)
    const next = value + delta
    if (!Number.isSafeInteger(next)) throw new RangeError(`AppState counter ${key} would leave the safe integers`)
    if ((bounds.min !== undefined && next < bounds.min) || (bounds.max !== undefined && next > bounds.max)) return { applied: false, current }
    return { applied: true, entry: this.write(key, JSON.stringify(next), policy, expiry, current) }
  }

  consume(key: string, revision?: string): ConsumeAnswer {
    const current = this.read(key)
    if (!current || (revision !== undefined && current.revision !== revision)) return { consumed: false, current }
    this.delete(key)
    return { consumed: true, entry: current }
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

  /** The live entry, forgetting it once it has expired. */
  private read(key: string): StoredEntry | null {
    const row = this.sql.exec<EntryRow>('SELECT json, revision, expires_at FROM app_state WHERE key = ?', key).toArray()[0]
    if (!row) return null
    if (row.expires_at !== null && row.expires_at <= this.now()) {
      this.delete(key)
      return null
    }
    return { json: row.json, revision: row.revision, expiresAt: row.expires_at === null ? null : Number(row.expires_at) }
  }

  private write(key: string, json: string, policy: KeyPolicy, expiry: Expiry | undefined, current: StoredEntry | null): StoredEntry {
    const now = this.now()
    this.sweep(now)
    const expiresAt = resolveExpiry(policy as unknown as Namespace<unknown>, expiry, current ?? undefined, now)
    const revision = `${this.epoch}.${++this.sequence}`
    this.sql.exec(
      'INSERT INTO app_state (key, json, revision, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET json = excluded.json, revision = excluded.revision, expires_at = excluded.expires_at',
      key, json, revision, expiresAt,
    )
    return { json, revision, expiresAt }
  }

  private sweep(now: number): void {
    if (now - this.sweptAt < SWEEP_EVERY_MS) return
    this.sweptAt = now
    this.sql.exec('DELETE FROM app_state WHERE expires_at <= ?', now)
  }
}
