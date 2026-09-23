/**
 * Webhook relay backed by the platform proxy.
 *
 * Queued events on the platform are the source of truth; everything else is a
 * reason to claim them sooner. Claims run in one coalesced loop per host:
 * a realtime INSERT for a registered endpoint wakes it, a tick polls while
 * realtime is down, and a slower reconciliation claim covers notifications
 * that never arrived. Claimed events are handed to their endpoint's consumer
 * and acknowledged once the consumer settles them (anything but `retry`).
 *
 * Claims are final on the platform today: an event claimed but not settled
 * before the process exits is not redelivered (SUP-931). `retry` events stay
 * in memory and are offered again with backoff until they settle.
 */

import pLimit from 'p-limit'
import { captureException } from '@shared/lib/error-reporting'
import type { RealtimeConfig } from '@shared/lib/services/supabase-realtime-client'
import type { PlatformClaim } from './platform-relay-client'
import { platformRealtimeRecordSchema } from './platform-relay-schema'
import {
  LOCAL_RELAY_SCOPE,
  type RelayAcceptResult,
  type RelayConsumer,
  type RelayConsumerHandle,
  type RelayEvent,
  type RelayScope,
  type WebhookRelayService,
  type WebhookRelaySnapshot,
  type WebhookRelayTransport,
} from './types'

// Platform limits (apps/proxy/src/upstreams/webhook-events.ts): a claim
// returns at most 50 events and takes at most 500 endpoint ids of this shape;
// one invalid id fails the whole claim.
const CLAIM_BATCH_SIZE = 50
const MAX_ENDPOINTS_PER_CLAIM = 500
const VALID_ENDPOINT_ID = /^(ti|whep)_[A-Za-z0-9_-]{1,128}$/
// Acked ids end up in the proxy's Supabase filter URL.
const ACK_CHUNK_SIZE = 100
const MAX_DEFERRED_ACKS_PER_SCOPE = 1000

export interface RealtimeConnection {
  /** `onConnect` runs on every open, including the connection's own reconnects. */
  connect(
    config: RealtimeConfig,
    onInsert: (record: unknown) => void,
    onDisconnect?: () => void,
    onConnect?: () => void,
  ): Promise<void>
  disconnect(): void
  isActive(): boolean
  updateToken(jwt: string): Promise<void>
}

export interface PlatformWebhookRelayDeps {
  claim(scope: RelayScope, endpointIds: readonly string[]): Promise<PlatformClaim>
  acknowledge(scope: RelayScope, eventIds: readonly string[]): Promise<void>
  getToken(): string | null
  /** True for an org token, which needs a real member scope on every call. */
  requiresMemberScope(): boolean
  createRealtime(): RealtimeConnection
  /** Runs fn, and what it schedules, outside any request/attribution scope. */
  detach<T>(fn: () => T): T
}

export interface PlatformWebhookRelayOptions {
  /** Polling cadence while realtime is down; also how often the rest is checked. */
  tickMs?: number
  /** Claim at least this often even with realtime up, for missed notifications. */
  reconcileMs?: number
  /** Realtime JWTs last an hour; hand the socket a fresh one after this long. */
  realtimeTokenRefreshMs?: number
  /** Stop claiming a consumer's endpoints while this many of its events wait. */
  maxConsumerBacklog?: number
  retryDelaysMs?: readonly number[]
  acceptConcurrency?: number
}

interface QueuedEvent {
  event: RelayEvent
  /** The scope that claimed it, which is the one that must acknowledge it. */
  scope: RelayScope
}

interface ConsumerState {
  id: string
  scope: RelayScope
  endpointIds: Set<string>
  accept: RelayConsumer['accept']
  queue: QueuedEvent[]
  queuedIds: Set<string>
  offering: boolean
  retryTimer: NodeJS.Timeout | null
  retryAttempt: number
  disposed: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

export class PlatformWebhookRelayService implements WebhookRelayService {
  readonly kind = 'platform' as const

  private readonly tickMs: number
  private readonly reconcileMs: number
  private readonly realtimeTokenRefreshMs: number
  private readonly maxConsumerBacklog: number
  private readonly retryDelaysMs: readonly number[]
  private readonly limit: ReturnType<typeof pLimit>

  private readonly consumers = new Map<string, ConsumerState>()
  private readonly owners = new Map<string, ConsumerState>()
  private readonly listeners = new Set<(snapshot: WebhookRelaySnapshot) => void>()
  private readonly deferredAcks = new Map<RelayScope, Set<string>>()
  private readonly failingScopes = new Set<RelayScope>()

  private started = false
  private online = false
  private token: string | null = null
  // Bumped whenever the connection goes away, so async work from an older
  // identity can't touch the current one's realtime client or status.
  private generation = 0
  private tick: NodeJS.Timeout | null = null
  private realtime: RealtimeConnection | null = null
  private realtimeConnecting = false
  private realtimeTokenAt = 0
  private dirty = false
  private draining = false
  private lastRoundAt = 0
  private health: 'unknown' | 'ok' | 'failed' = 'unknown'
  private lastClaimAt: string | null = null
  private lastError: string | null = null
  private warnedLocalScope = false
  private lastEmitted = ''

  constructor(
    private readonly deps: PlatformWebhookRelayDeps,
    options: PlatformWebhookRelayOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 30_000
    this.reconcileMs = options.reconcileMs ?? 5 * 60_000
    this.realtimeTokenRefreshMs = options.realtimeTokenRefreshMs ?? 40 * 60_000
    this.maxConsumerBacklog = options.maxConsumerBacklog ?? 200
    this.retryDelaysMs = options.retryDelaysMs ?? [5_000, 30_000, 2 * 60_000, 10 * 60_000]
    this.limit = pLimit(options.acceptConcurrency ?? 4)
  }

  // ==========================================================================
  // Status
  // ==========================================================================

  snapshot(): WebhookRelaySnapshot {
    if (!this.online) {
      return {
        available: false,
        unavailableReason: 'platform_disconnected',
        transport: 'idle',
        lastClaimAt: this.lastClaimAt,
        lastError: null,
      }
    }
    return {
      available: true,
      unavailableReason: null,
      transport: this.transport(),
      lastClaimAt: this.lastClaimAt,
      lastError: this.health === 'failed' ? this.lastError : null,
    }
  }

  onChange(listener: (snapshot: WebhookRelaySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private transport(): WebhookRelayTransport {
    if (!this.hasEndpoints()) return 'idle'
    if (this.health === 'unknown') return 'connecting'
    if (this.health === 'failed') return 'unreachable'
    return this.realtime?.isActive() ? 'realtime' : 'polling'
  }

  private emit(): void {
    const snapshot = this.snapshot()
    const key = [snapshot.available, snapshot.unavailableReason, snapshot.transport, snapshot.lastError].join('|')
    if (key === this.lastEmitted) return
    this.lastEmitted = key
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        captureException(error, { tags: { area: 'webhook-relay', op: 'status-listener' } })
      }
    }
  }

  // ==========================================================================
  // Consumers
  // ==========================================================================

  register(consumer: RelayConsumer): RelayConsumerHandle {
    if (this.consumers.has(consumer.id)) {
      throw new Error(`Webhook relay consumer ${consumer.id} is already registered`)
    }
    const state: ConsumerState = {
      id: consumer.id,
      scope: consumer.scope,
      endpointIds: this.validEndpointIds(consumer.id, consumer.endpointIds),
      accept: consumer.accept,
      queue: [],
      queuedIds: new Set(),
      offering: false,
      retryTimer: null,
      retryAttempt: 0,
      disposed: false,
    }
    this.takeOwnership(state)
    this.consumers.set(state.id, state)
    this.wake()
    this.emit()

    return {
      update: (changes) => {
        if (state.disposed) return
        const previous = { scope: state.scope, endpointIds: state.endpointIds }
        this.releaseOwnership(state)
        state.scope = changes.scope ?? state.scope
        if (changes.endpointIds) state.endpointIds = this.validEndpointIds(state.id, changes.endpointIds)
        try {
          this.takeOwnership(state)
        } catch (error) {
          Object.assign(state, previous)
          this.takeOwnership(state)
          throw error
        }
        this.wake()
        this.emit()
      },
      dispose: () => {
        if (state.disposed) return
        state.disposed = true
        this.releaseOwnership(state)
        this.consumers.delete(state.id)
        if (state.retryTimer) clearTimeout(state.retryTimer)
        state.retryTimer = null
        state.queue = []
        state.queuedIds.clear()
        if (!this.hasEndpoints()) this.dropRealtime()
        this.emit()
      },
    }
  }

  private validEndpointIds(consumerId: string, endpointIds: readonly string[]): Set<string> {
    const valid = new Set<string>()
    for (const id of endpointIds) {
      if (VALID_ENDPOINT_ID.test(id)) valid.add(id)
      else console.warn(`[WebhookRelay] Ignoring endpoint id "${id}" from ${consumerId}: the relay would reject every claim that includes it`)
    }
    return valid
  }

  private ownerKey(scope: RelayScope, endpointId: string): string {
    return `${scope}\n${endpointId}`
  }

  private takeOwnership(state: ConsumerState): void {
    for (const endpointId of state.endpointIds) {
      const owner = this.owners.get(this.ownerKey(state.scope, endpointId))
      if (owner && owner !== state) {
        throw new Error(`Webhook relay endpoint ${endpointId} in scope ${state.scope} already belongs to ${owner.id}`)
      }
    }
    for (const endpointId of state.endpointIds) this.owners.set(this.ownerKey(state.scope, endpointId), state)
  }

  private releaseOwnership(state: ConsumerState): void {
    for (const endpointId of state.endpointIds) {
      const key = this.ownerKey(state.scope, endpointId)
      if (this.owners.get(key) === state) this.owners.delete(key)
    }
  }

  private hasEndpoints(): boolean {
    for (const state of this.consumers.values()) if (state.endpointIds.size > 0) return true
    return false
  }

  private isRegisteredEndpoint(endpointId: string): boolean {
    for (const state of this.consumers.values()) if (state.endpointIds.has(endpointId)) return true
    return false
  }

  private isSaturated(scope: RelayScope, endpointId: string): boolean {
    const owner = this.owners.get(this.ownerKey(scope, endpointId))
    return owner !== undefined && owner.queue.length >= this.maxConsumerBacklog
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  start(): void {
    if (this.started) return
    this.started = true
    this.applyAuth()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.goOffline()
    this.emit()
  }

  onAuthChanged(): void {
    if (this.started) this.applyAuth()
  }

  private applyAuth(): void {
    const token = this.deps.getToken()
    if (!token) {
      if (this.online) console.log('[WebhookRelay] Platform disconnected; delivery paused')
      this.goOffline()
      this.emit()
      return
    }
    if (this.online && token === this.token) {
      this.wake()
      return
    }
    // New or changed identity: start over so nothing from the old token (its
    // realtime JWT above all) carries across.
    this.goOffline()
    this.token = token
    this.online = true
    this.deps.detach(() => {
      this.tick = setInterval(() => this.onTick(), this.tickMs)
      this.tick.unref?.()
    })
    console.log('[WebhookRelay] Online')
    this.wake()
    this.emit()
  }

  private goOffline(): void {
    this.generation++
    this.online = false
    this.dirty = false
    this.health = 'unknown'
    this.failingScopes.clear()
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    this.dropRealtime()
  }

  private onTick(): void {
    if (!this.online) return
    const realtimeUp = this.realtime?.isActive() ?? false
    if (!realtimeUp || Date.now() - this.lastRoundAt >= this.reconcileMs) this.wake()
    // Realtime may have dropped since the last round.
    this.emit()
  }

  // ==========================================================================
  // Claiming
  // ==========================================================================

  wake(): void {
    if (!this.online) return
    this.dirty = true
    if (this.draining) return
    this.draining = true
    this.deps.detach(() => {
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty && this.online) {
        this.dirty = false
        await this.runRound(this.generation)
      }
    } catch (error) {
      captureException(error, { tags: { area: 'webhook-relay', op: 'drain' } })
    } finally {
      this.draining = false
      this.emit()
    }
  }

  private claimPlan(): Map<RelayScope, string[]> {
    const plan = new Map<RelayScope, Set<string>>()
    for (const state of this.consumers.values()) {
      if (state.endpointIds.size === 0) continue
      let ids = plan.get(state.scope)
      if (!ids) plan.set(state.scope, (ids = new Set()))
      for (const id of state.endpointIds) ids.add(id)
    }
    return new Map([...plan].map(([scope, ids]) => [scope, [...ids]]))
  }

  private async runRound(generation: number): Promise<void> {
    this.lastRoundAt = Date.now()
    await this.flushDeferredAcks(generation)
    const plan = this.claimPlan()
    if (plan.size === 0) {
      this.dropRealtime()
      return
    }

    let succeeded = 0
    let failed = 0
    let lastError: string | null = null
    for (const [scope, endpointIds] of plan) {
      if (generation !== this.generation) return
      if (scope === LOCAL_RELAY_SCOPE && this.deps.requiresMemberScope()) {
        if (!this.warnedLocalScope) {
          this.warnedLocalScope = true
          console.warn('[WebhookRelay] Skipping the local scope: an org token claims per member')
        }
        continue
      }
      const error = await this.claimScope(generation, scope, endpointIds)
      if (error === null) succeeded++
      else {
        failed++
        lastError = error
      }
    }
    if (generation !== this.generation) return

    // One member's failure (e.g. it left the org) doesn't make the relay
    // unhealthy for everyone else.
    if (succeeded > 0) {
      this.health = 'ok'
      this.lastClaimAt = new Date().toISOString()
      this.lastError = null
    } else if (failed > 0) {
      this.health = 'failed'
      this.lastError = lastError
    }
  }

  /** Claims until each batch comes back short. Returns the error, or null. */
  private async claimScope(generation: number, scope: RelayScope, endpointIds: string[]): Promise<string | null> {
    for (const ids of chunk(endpointIds, MAX_ENDPOINTS_PER_CLAIM)) {
      let remaining = ids
      for (;;) {
        remaining = remaining.filter((id) => !this.isSaturated(scope, id))
        if (remaining.length === 0) break
        let claim: PlatformClaim
        try {
          claim = await this.deps.claim(scope, remaining)
        } catch (error) {
          const message = errorMessage(error)
          console.warn(`[WebhookRelay] Claim failed for scope ${scope}: ${message}`)
          if (!this.failingScopes.has(scope)) {
            this.failingScopes.add(scope)
            captureException(error, { level: 'warning', tags: { area: 'webhook-relay', op: 'claim' } })
          }
          return message
        }
        if (claim.claimed > 0) console.log(`[WebhookRelay] Claimed ${claim.claimed} event(s) for scope ${scope}`)
        // Claimed rows are ours whatever happened meanwhile; dispatch them
        // even if the identity changed, then stop.
        this.dispatch(scope, claim.events)
        if (generation !== this.generation) return null
        this.useRealtimeConfig(generation, claim.realtime)
        if (claim.claimed < CLAIM_BATCH_SIZE) break
      }
    }
    this.failingScopes.delete(scope)
    return null
  }

  // ==========================================================================
  // Delivery
  // ==========================================================================

  private dispatch(scope: RelayScope, events: readonly RelayEvent[]): void {
    const unowned: string[] = []
    const touched = new Set<ConsumerState>()
    for (const event of events) {
      const owner = this.owners.get(this.ownerKey(scope, event.endpointId))
      if (!owner) {
        unowned.push(event.id)
        continue
      }
      if (owner.queuedIds.has(event.id)) continue
      owner.queue.push({ event, scope })
      owner.queuedIds.add(event.id)
      touched.add(owner)
    }
    if (unowned.length > 0) {
      // Its consumer let go of the endpoint while the claim was in flight.
      console.warn(`[WebhookRelay] Discarding ${unowned.length} event(s) with no consumer in scope ${scope}`)
      void this.acknowledge(scope, unowned)
    }
    for (const state of touched) this.pump(state)
  }

  private pump(state: ConsumerState): void {
    if (state.offering || state.retryTimer || state.disposed || state.queue.length === 0) return
    state.offering = true
    this.deps.detach(() => {
      void this.limit(() => this.offer(state))
        .catch((error: unknown) => {
          captureException(error, { tags: { area: 'webhook-relay', op: 'offer' }, extra: { consumerId: state.id } })
        })
        .finally(() => {
          state.offering = false
          this.pump(state)
        })
    })
  }

  private async offer(state: ConsumerState): Promise<void> {
    const wasSaturated = state.queue.length >= this.maxConsumerBacklog
    const batch = state.queue.slice(0, CLAIM_BATCH_SIZE)

    let outcome: RelayAcceptResult | ReadonlyMap<string, RelayAcceptResult>
    try {
      outcome = await state.accept(batch.map((queued) => queued.event))
    } catch (error) {
      console.error(`[WebhookRelay] Consumer ${state.id} failed to accept ${batch.length} event(s):`, error)
      captureException(error, { tags: { area: 'webhook-relay', op: 'accept' }, extra: { consumerId: state.id } })
      outcome = 'retry'
    }
    if (state.disposed) return

    const settled: QueuedEvent[] = []
    let retrying = false
    for (const queued of batch) {
      const result = typeof outcome === 'string' ? outcome : (outcome.get(queued.event.id) ?? 'retry')
      if (result === 'retry') retrying = true
      else settled.push(queued)
    }
    if (settled.length > 0) {
      const settledIds = new Set(settled.map((queued) => queued.event.id))
      state.queue = state.queue.filter((queued) => !settledIds.has(queued.event.id))
      for (const id of settledIds) state.queuedIds.delete(id)
    }

    if (retrying) this.scheduleRetry(state)
    else state.retryAttempt = 0

    const byScope = new Map<RelayScope, string[]>()
    for (const queued of settled) {
      const ids = byScope.get(queued.scope) ?? []
      ids.push(queued.event.id)
      byScope.set(queued.scope, ids)
    }
    for (const [scope, ids] of byScope) await this.acknowledge(scope, ids)

    // The rounds skipped this consumer's endpoints while it was full.
    if (wasSaturated && state.queue.length < this.maxConsumerBacklog) this.wake()
  }

  private scheduleRetry(state: ConsumerState): void {
    const delay = this.retryDelaysMs[Math.min(state.retryAttempt, this.retryDelaysMs.length - 1)]
    state.retryAttempt++
    this.deps.detach(() => {
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null
        this.pump(state)
      }, delay)
      state.retryTimer.unref?.()
    })
  }

  private async acknowledge(scope: RelayScope, eventIds: readonly string[]): Promise<void> {
    if (!this.online) {
      this.deferAcks(scope, eventIds)
      return
    }
    for (const ids of chunk(eventIds, ACK_CHUNK_SIZE)) {
      try {
        await this.deps.acknowledge(scope, ids)
      } catch (error) {
        console.warn(`[WebhookRelay] Ack failed for scope ${scope}; will retry: ${errorMessage(error)}`)
        this.deferAcks(scope, ids)
      }
    }
  }

  private deferAcks(scope: RelayScope, eventIds: readonly string[]): void {
    const deferred = this.deferredAcks.get(scope) ?? new Set<string>()
    for (const id of eventIds) deferred.add(id)
    // Unacked events are already handled here; the platform fails them after
    // 48h. Bounded so a scope that can never ack can't grow without limit.
    for (const id of deferred) {
      if (deferred.size <= MAX_DEFERRED_ACKS_PER_SCOPE) break
      deferred.delete(id)
    }
    this.deferredAcks.set(scope, deferred)
  }

  private async flushDeferredAcks(generation: number): Promise<void> {
    for (const [scope, ids] of [...this.deferredAcks]) {
      if (generation !== this.generation) return
      this.deferredAcks.delete(scope)
      await this.acknowledge(scope, [...ids])
    }
  }

  // ==========================================================================
  // Realtime
  // ==========================================================================

  private useRealtimeConfig(generation: number, config: RealtimeConfig | null): void {
    if (!config) return
    const now = Date.now()
    const current = this.realtime
    if (current?.isActive()) {
      if (now - this.realtimeTokenAt >= this.realtimeTokenRefreshMs) {
        this.realtimeTokenAt = now
        current.updateToken(config.jwt).catch((error: unknown) => {
          console.warn(`[WebhookRelay] Realtime token refresh failed: ${errorMessage(error)}`)
        })
      }
      return
    }
    if (this.realtimeConnecting) return

    // Never connected, or closed and retrying with a JWT that may have
    // expired, or given up: start over with the credentials just minted.
    this.dropRealtime()
    const client = this.deps.createRealtime()
    this.realtime = client
    this.realtimeConnecting = true
    this.realtimeTokenAt = now
    client
      .connect(
        config,
        (record) => this.onRealtimeInsert(record),
        () => this.emit(),
        () => {
          if (generation !== this.generation || this.realtime !== client) return
          // Nothing announced events inserted before this (re)subscription,
          // whether it's the first one or the socket reconnecting by itself.
          this.wake()
          this.emit()
        },
      )
      .then(() => {
        if (generation !== this.generation || this.realtime !== client) {
          client.disconnect()
          return
        }
        console.log('[WebhookRelay] Realtime connected')
      })
      .catch((error: unknown) => {
        if (this.realtime === client) console.warn(`[WebhookRelay] Realtime connect failed; polling: ${errorMessage(error)}`)
      })
      .finally(() => {
        if (this.realtime === client) this.realtimeConnecting = false
        this.emit()
      })
  }

  private onRealtimeInsert(raw: unknown): void {
    // The org-wide channel also carries other members' and other hosts'
    // events; only wake for ours. An unreadable record wakes anyway.
    const record = platformRealtimeRecordSchema.safeParse(raw)
    if (record.success) {
      const { composio_trigger_id: endpointId, status } = record.data
      if (status !== undefined && status !== 'pending') return
      if (endpointId !== undefined && !this.isRegisteredEndpoint(endpointId)) return
    }
    this.wake()
  }

  private dropRealtime(): void {
    this.realtimeConnecting = false
    const client = this.realtime
    this.realtime = null
    client?.disconnect()
  }
}
