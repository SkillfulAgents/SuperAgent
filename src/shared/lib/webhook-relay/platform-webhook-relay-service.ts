/**
 * Webhook relay backed by the platform proxy.
 *
 * Queued events on the platform are the source of truth; everything else is a
 * reason to claim them sooner. Claims run in one coalesced loop per host:
 * a realtime INSERT for a registered endpoint wakes it, a tick polls while
 * realtime is down, and a slower reconciliation claim covers notifications
 * that never arrived. Claimed events are handed to their endpoint's consumer,
 * and acknowledged by a separate worker once the consumer settles them
 * (anything but `retry`).
 *
 * Claims are final on the platform today: an event claimed but not settled
 * before the process exits is not redelivered (SUP-931). `retry` events stay
 * in memory and are offered again with backoff until they settle.
 */

import pLimit from 'p-limit'
import { captureException } from '@shared/lib/error-reporting'
import type { RealtimeConfig } from '@shared/lib/services/supabase-realtime-client'
import type {
  VerificationProfile,
  WebhookEndpoint,
  WebhookEndpointEvent,
  WebhookFilterTestResult,
} from '@shared/lib/services/webhook-endpoint-schema'
import { WebhookRelayUnavailableError } from './errors'
import type { PlatformClaim } from './platform-relay-client'
import { platformRealtimeRecordSchema } from './platform-relay-schema'
import {
  LOCAL_RELAY_SCOPE,
  type RelayAcceptResult,
  type RelayConsumer,
  type RelayConsumerHandle,
  type RelayEndpoint,
  type RelayEndpointChanges,
  type RelayEndpointEvents,
  type RelayEndpointSpec,
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

/** The platform's endpoint routes, in the platform's own vocabulary. */
export interface PlatformEndpointsApi {
  create(
    memberId: string,
    params: { name: string; verification?: VerificationProfile; filter_exp?: string },
  ): Promise<WebhookEndpoint>
  update(
    memberId: string,
    endpointId: string,
    params: { name?: string; verification?: VerificationProfile | null; filter_exp?: string | null },
  ): Promise<WebhookEndpoint>
  disable(memberId: string, endpointId: string): Promise<void>
  listEvents(
    memberId: string,
    endpointId: string,
    limit?: number,
  ): Promise<{ filterExp: string | null; events: WebhookEndpointEvent[] }>
  testFilter(memberId: string, endpointId: string, filterExp: string, limit?: number): Promise<WebhookFilterTestResult>
}

export interface PlatformWebhookRelayDeps {
  claim(scope: RelayScope, endpointIds: readonly string[], signal: AbortSignal): Promise<PlatformClaim>
  acknowledge(scope: RelayScope, eventIds: readonly string[], signal: AbortSignal): Promise<void>
  endpoints: PlatformEndpointsApi
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
  /** Stop claiming for a scope while this many of its acks wait. */
  maxPendingAcks?: number
  /** Claims one lane (a scope's chunk of endpoints) gets per round before the others go. */
  maxClaimsPerTurn?: number
  /** Deadline for each claim/ack request. */
  requestTimeoutMs?: number
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
  /** A claim skipped this consumer's endpoints because its queue was full. */
  heldBack: boolean
  /** Disposed, but still delivering events claimed before that. */
  draining: boolean
  /** Claims in flight that include this consumer's endpoints. */
  claimsInFlight: number
  disposed: boolean
}

interface ClaimLane {
  scope: RelayScope
  endpointIds: string[]
}

class RequestDeadlineError extends Error {
  constructor(ms: number) {
    super(`Webhook relay request timed out after ${ms}ms`)
    this.name = 'RequestDeadlineError'
  }
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
  private readonly maxPendingAcks: number
  private readonly maxClaimsPerTurn: number
  private readonly requestTimeoutMs: number
  private readonly retryDelaysMs: readonly number[]
  private readonly limit: ReturnType<typeof pLimit>

  private readonly consumers = new Map<string, ConsumerState>()
  private readonly drainingConsumers = new Set<ConsumerState>()
  private readonly owners = new Map<string, ConsumerState>()
  private readonly listeners = new Set<(snapshot: WebhookRelaySnapshot) => void>()
  private readonly failingScopes = new Set<RelayScope>()

  // Acks run in their own worker so a stalled or failing scope never holds up
  // claiming, delivery, or other scopes' acks.
  private readonly pendingAcks = new Map<RelayScope, Set<string>>()
  private readonly ackBackoff = new Map<RelayScope, { attempt: number; retryAt: number }>()
  /** Scopes whose claims were skipped because their acks had piled up. */
  private readonly ackHeldBack = new Set<RelayScope>()
  private acking = false
  private ackTimer: NodeJS.Timeout | null = null

  private started = false
  // Aborted by stop(), cancelling every request still in flight.
  private lifecycle = new AbortController()
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
    this.maxPendingAcks = options.maxPendingAcks ?? 1000
    this.maxClaimsPerTurn = options.maxClaimsPerTurn ?? 4
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
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
        unavailableReason: this.started ? 'platform_disconnected' : 'stopped',
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
    if (!this.hasClaimableEndpoints()) return 'idle'
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
  // Endpoints
  // ==========================================================================

  // The same answer the snapshot gives, so nothing mints a URL whose events
  // would never be claimed (before start(), after stop(), or offline).
  private requireAvailable(): void {
    const { unavailableReason } = this.snapshot()
    if (unavailableReason) throw new WebhookRelayUnavailableError(unavailableReason)
  }

  async createEndpoint(scope: RelayScope, spec: RelayEndpointSpec): Promise<RelayEndpoint> {
    this.requireAvailable()
    return this.deps.endpoints.create(scope, {
      name: spec.name,
      ...(spec.verification ? { verification: spec.verification } : {}),
      ...(spec.filterExp ? { filter_exp: spec.filterExp } : {}),
    })
  }

  async updateEndpoint(scope: RelayScope, endpointId: string, changes: RelayEndpointChanges): Promise<RelayEndpoint> {
    this.requireAvailable()
    return this.deps.endpoints.update(scope, endpointId, {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.verification !== undefined ? { verification: changes.verification } : {}),
      ...(changes.filterExp !== undefined ? { filter_exp: changes.filterExp } : {}),
    })
  }

  async disableEndpoint(scope: RelayScope, endpointId: string): Promise<void> {
    this.requireAvailable()
    await this.deps.endpoints.disable(scope, endpointId)
  }

  async listEndpointEvents(scope: RelayScope, endpointId: string, limit?: number): Promise<RelayEndpointEvents> {
    this.requireAvailable()
    return this.deps.endpoints.listEvents(scope, endpointId, limit)
  }

  async testEndpointFilter(
    scope: RelayScope,
    endpointId: string,
    filterExp: string,
    limit?: number,
  ): Promise<WebhookFilterTestResult> {
    this.requireAvailable()
    return this.deps.endpoints.testFilter(scope, endpointId, filterExp, limit)
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
      heldBack: false,
      draining: false,
      claimsInFlight: 0,
      disposed: false,
    }
    this.takeOwnership(state)
    this.consumers.set(state.id, state)
    this.wake()
    this.emit()

    return {
      update: (changes) => {
        if (state.disposed || state.draining) return
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
        if (state.disposed || state.draining) return
        this.releaseOwnership(state)
        this.consumers.delete(state.id)
        // Nothing more is claimed for it, but what was already claimed,
        // queued or still in flight, is delivered first: those events exist
        // nowhere else (SUP-931).
        state.draining = true
        this.drainingConsumers.add(state)
        this.finishIfDrained(state)
        if (!this.hasEndpoints()) this.dropRealtime()
        this.emit()
      },
    }
  }

  private finishIfDrained(state: ConsumerState): void {
    if (state.draining && state.queue.length === 0 && state.claimsInFlight === 0 && !state.offering) this.finish(state)
  }

  private finish(state: ConsumerState): void {
    state.disposed = true
    state.draining = false
    this.drainingConsumers.delete(state)
    if (state.retryTimer) clearTimeout(state.retryTimer)
    state.retryTimer = null
    state.queue = []
    state.queuedIds.clear()
  }

  /** Registered consumers and disposed ones still delivering. */
  private deliveringConsumers(): ConsumerState[] {
    return [...this.consumers.values(), ...this.drainingConsumers]
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

  /** Registered endpoints in a scope this token can claim. */
  private hasClaimableEndpoints(): boolean {
    const orgToken = this.deps.requiresMemberScope()
    for (const state of this.consumers.values()) {
      if (state.endpointIds.size > 0 && !(orgToken && state.scope === LOCAL_RELAY_SCOPE)) return true
    }
    return false
  }

  private isRegisteredEndpoint(endpointId: string): boolean {
    for (const state of this.consumers.values()) if (state.endpointIds.has(endpointId)) return true
    return false
  }

  /**
   * Still owned by a consumer in this scope, with room for more events and
   * acks. A skip for lack of room is recorded, so whatever frees the room
   * (the consumer draining, or acks going through) wakes the loop again.
   */
  private isClaimable(scope: RelayScope, endpointId: string): boolean {
    const owner = this.owners.get(this.ownerKey(scope, endpointId))
    if (!owner) return false
    if (owner.queue.length >= this.maxConsumerBacklog) {
      owner.heldBack = true
      return false
    }
    if ((this.pendingAcks.get(scope)?.size ?? 0) >= this.maxPendingAcks) {
      this.ackHeldBack.add(scope)
      return false
    }
    return true
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  start(): void {
    if (this.started) return
    this.started = true
    this.lifecycle = new AbortController()
    this.applyAuth()
    // Resume delivery that stop() suspended.
    for (const state of this.deliveringConsumers()) this.pump(state)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.lifecycle.abort(new Error('Webhook relay stopped'))
    for (const state of this.deliveringConsumers()) {
      if (state.retryTimer) clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
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
    this.flushAcks()
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
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    this.dropRealtime()
  }

  private onTick(): void {
    if (!this.online) return
    const realtimeUp = this.realtime?.isActive() ?? false
    if (!realtimeUp || Date.now() - this.lastRoundAt >= this.reconcileMs) this.wake()
    // Realtime may have dropped since the last round.
    this.emit()
  }

  /**
   * Runs one platform request, cancelled by stop(). Waiting is bounded by a
   * deadline, and settles even if the request ignores its signal, so a hung
   * request can never wedge the claim loop or the ack worker.
   *
   * With `late`, the deadline only stops the waiting: the request keeps
   * going, rejects with RequestDeadlineError, and its eventual outcome goes
   * to `late`. A claim needs that, because the platform may already have
   * claimed the rows (claims are final until SUP-931), and cancelling would
   * lose them. Anything else is cancelled at the deadline.
   */
  private request<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    late?: { result(result: T): void; failure(): void },
  ): Promise<T> {
    const controller = new AbortController()
    const lifecycle = this.lifecycle.signal
    const onStop = () => controller.abort(lifecycle.reason)
    lifecycle.addEventListener('abort', onStop, { once: true })
    if (lifecycle.aborted) onStop()
    const run = new Promise<T>((resolve) => resolve(fn(controller.signal)))
    void run.catch(() => {}).finally(() => lifecycle.removeEventListener('abort', onStop))

    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (late) void run.then(late.result, late.failure)
        else controller.abort(new Error('deadline'))
        reject(new RequestDeadlineError(this.requestTimeoutMs))
      }, this.requestTimeoutMs)
    })
    const cancelled = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason)
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    return Promise.race([run, deadline, cancelled]).finally(() => clearTimeout(timer))
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

  /** One lane per scope and chunk of at most 500 endpoints. */
  private claimLanes(): ClaimLane[] {
    const byScope = new Map<RelayScope, Set<string>>()
    for (const state of this.consumers.values()) {
      if (state.endpointIds.size === 0) continue
      let ids = byScope.get(state.scope)
      if (!ids) byScope.set(state.scope, (ids = new Set()))
      for (const id of state.endpointIds) ids.add(id)
    }
    const lanes: ClaimLane[] = []
    for (const [scope, ids] of byScope) {
      for (const endpointIds of chunk([...ids], MAX_ENDPOINTS_PER_CLAIM)) lanes.push({ scope, endpointIds })
    }
    return lanes
  }

  private async runRound(generation: number): Promise<void> {
    this.lastRoundAt = Date.now()
    const lanes = this.claimLanes()
    if (lanes.length === 0) {
      this.dropRealtime()
      return
    }

    let succeeded = 0
    let failed = 0
    let lastError: string | null = null
    const failedScopes = new Set<RelayScope>()
    for (const lane of lanes) {
      if (generation !== this.generation) return
      if (failedScopes.has(lane.scope)) continue
      if (lane.scope === LOCAL_RELAY_SCOPE && this.deps.requiresMemberScope()) {
        if (!this.warnedLocalScope) {
          this.warnedLocalScope = true
          console.warn('[WebhookRelay] Skipping the local scope: an org token claims per member')
        }
        continue
      }
      const { error, more } = await this.claimLane(generation, lane)
      if (error === null) {
        succeeded++
        // Still full after its turn: every other lane goes first, then it
        // gets another round.
        if (more) this.dirty = true
      } else {
        failed++
        lastError = error
        failedScopes.add(lane.scope)
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

  /** Claims a lane for at most maxClaimsPerTurn batches. */
  private async claimLane(generation: number, lane: ClaimLane): Promise<{ error: string | null; more: boolean }> {
    const { scope } = lane
    for (let turn = 0; turn < this.maxClaimsPerTurn; turn++) {
      // Re-checked before every claim: a consumer may have let go of an
      // endpoint or filled its backlog since the lane was planned, and a
      // claim for an endpoint nobody owns would take events nobody delivers.
      const endpointIds = lane.endpointIds.filter((id) => this.isClaimable(scope, id))
      // A full consumer wakes the loop itself once it drains.
      if (endpointIds.length === 0) return { error: null, more: false }
      // The response goes to whoever owned each endpoint when the claim was
      // sent, even if that consumer is disposed meanwhile (e.g. replaced by a
      // registration under another scope): it stays draining until then.
      const owners = new Map(endpointIds.map((id) => [id, this.owners.get(this.ownerKey(scope, id))!]))
      const holders = new Set(owners.values())
      for (const holder of holders) holder.claimsInFlight++
      let released = false
      const release = () => {
        if (released) return
        released = true
        for (const holder of holders) {
          holder.claimsInFlight--
          this.finishIfDrained(holder)
        }
      }

      let claim: PlatformClaim
      try {
        claim = await this.request((signal) => this.deps.claim(scope, endpointIds, signal), {
          result: (late) => {
            if (late.claimed > 0) console.warn(`[WebhookRelay] Late claim response for scope ${scope}: ${late.claimed} event(s)`)
            this.dispatch(scope, late.events, owners)
            release()
          },
          failure: release,
        })
      } catch (error) {
        // Past the deadline the request is still outstanding; `late` releases it.
        if (!(error instanceof RequestDeadlineError)) release()
        const message = errorMessage(error)
        console.warn(`[WebhookRelay] Claim failed for scope ${scope}: ${message}`)
        if (!this.failingScopes.has(scope)) {
          this.failingScopes.add(scope)
          captureException(error, { level: 'warning', tags: { area: 'webhook-relay', op: 'claim' } })
        }
        return { error: message, more: false }
      }
      this.failingScopes.delete(scope)
      if (claim.claimed > 0) console.log(`[WebhookRelay] Claimed ${claim.claimed} event(s) for scope ${scope}`)
      // Claimed rows are ours whatever happened meanwhile; dispatch them
      // even if the identity changed, then stop.
      this.dispatch(scope, claim.events, owners)
      release()
      if (generation !== this.generation) return { error: null, more: false }
      this.useRealtimeConfig(generation, claim.realtime)
      if (claim.claimed < CLAIM_BATCH_SIZE) return { error: null, more: false }
    }
    return { error: null, more: true }
  }

  // ==========================================================================
  // Delivery
  // ==========================================================================

  /** Queues claimed events for the consumers that owned their endpoints when the claim went out. */
  private dispatch(scope: RelayScope, events: readonly RelayEvent[], owners: ReadonlyMap<string, ConsumerState>): void {
    let unowned = 0
    const touched = new Set<ConsumerState>()
    for (const event of events) {
      const owner = owners.get(event.endpointId)
      if (!owner || owner.disposed) {
        unowned++
        continue
      }
      if (owner.queuedIds.has(event.id)) continue
      owner.queue.push({ event, scope })
      owner.queuedIds.add(event.id)
      touched.add(owner)
    }
    if (unowned > 0) {
      // Only for an endpoint the claim didn't ask for. Nothing delivered it,
      // so it isn't acknowledged: once claims lease (SUP-931) it returns to
      // the queue.
      console.warn(`[WebhookRelay] Leaving ${unowned} claimed event(s) unacknowledged: no consumer asked for them in scope ${scope}`)
    }
    for (const state of touched) this.pump(state)
  }

  private pump(state: ConsumerState): void {
    if (!this.started || state.offering || state.retryTimer || state.disposed || state.queue.length === 0) return
    state.offering = true
    this.deps.detach(() => {
      void this.limit(() => this.offer(state))
        .catch((error: unknown) => {
          captureException(error, { tags: { area: 'webhook-relay', op: 'offer' }, extra: { consumerId: state.id } })
        })
        .finally(() => {
          state.offering = false
          this.finishIfDrained(state)
          this.pump(state)
        })
    })
  }

  private async offer(state: ConsumerState): Promise<void> {
    // stop() may have landed while this offer waited for a concurrency slot.
    if (!this.started || state.disposed) return
    const batch = state.queue.slice(0, CLAIM_BATCH_SIZE)

    let outcome: RelayAcceptResult | ReadonlyMap<string, RelayAcceptResult>
    try {
      outcome = await state.accept(batch.map((queued) => queued.event))
    } catch (error) {
      console.error(`[WebhookRelay] Consumer ${state.id} failed to accept ${batch.length} event(s):`, error)
      captureException(error, { tags: { area: 'webhook-relay', op: 'accept' }, extra: { consumerId: state.id } })
      outcome = 'retry'
    }

    const settled: QueuedEvent[] = []
    let retrying = false
    for (const queued of batch) {
      const result = typeof outcome === 'string' ? outcome : (outcome.get(queued.event.id) ?? 'retry')
      if (result === 'retry') retrying = true
      else settled.push(queued)
    }
    // Settled work is done even if the consumer let go meanwhile.
    for (const queued of settled) this.queueAck(queued.scope, queued.event.id)
    this.flushAcks()
    if (state.disposed) return

    if (settled.length > 0) {
      const settledIds = new Set(settled.map((queued) => queued.event.id))
      state.queue = state.queue.filter((queued) => !settledIds.has(queued.event.id))
      for (const id of settledIds) state.queuedIds.delete(id)
    }

    if (retrying) this.scheduleRetry(state)
    else state.retryAttempt = 0

    if (state.draining) return
    // A round skipped this consumer's endpoints while it was full.
    if (state.heldBack && state.queue.length < this.maxConsumerBacklog) {
      state.heldBack = false
      this.wake()
    }
  }

  private scheduleRetry(state: ConsumerState): void {
    // After stop(), start() resumes delivery instead.
    if (!this.started || state.disposed) return
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

  // ==========================================================================
  // Acknowledgement
  // ==========================================================================

  // Never dropped: a scope whose acks pile up stops being claimed instead
  // (isClaimable), which bounds this by maxPendingAcks plus what consumers
  // already hold.
  private queueAck(scope: RelayScope, eventId: string): void {
    const pending = this.pendingAcks.get(scope) ?? new Set<string>()
    pending.add(eventId)
    this.pendingAcks.set(scope, pending)
  }

  private flushAcks(): void {
    if (this.acking || !this.online || this.pendingAcks.size === 0) return
    this.acking = true
    this.deps.detach(() => {
      void this.runAcks()
    })
  }

  private nextAckScope(): RelayScope | null {
    const now = Date.now()
    for (const scope of this.pendingAcks.keys()) {
      const backoff = this.ackBackoff.get(scope)
      if (!backoff || backoff.retryAt <= now) return scope
    }
    return null
  }

  private async runAcks(): Promise<void> {
    try {
      for (let scope = this.nextAckScope(); scope !== null && this.online; scope = this.nextAckScope()) {
        const ackScope = scope
        const pending = this.pendingAcks.get(ackScope)!
        const ids = [...pending].slice(0, ACK_CHUNK_SIZE)
        // Rotate to the back, so one busy scope can't keep the others waiting.
        this.pendingAcks.delete(ackScope)
        this.pendingAcks.set(ackScope, pending)
        try {
          await this.request((signal) => this.deps.acknowledge(ackScope, ids, signal))
          for (const id of ids) pending.delete(id)
          if (pending.size === 0) this.pendingAcks.delete(ackScope)
          this.ackBackoff.delete(ackScope)
          if (this.ackHeldBack.has(ackScope) && pending.size < this.maxPendingAcks) {
            this.ackHeldBack.delete(ackScope)
            this.wake()
          }
        } catch (error) {
          const attempt = this.ackBackoff.get(ackScope)?.attempt ?? 0
          const delay = this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)]
          this.ackBackoff.set(ackScope, { attempt: attempt + 1, retryAt: Date.now() + delay })
          console.warn(`[WebhookRelay] Ack failed for scope ${ackScope}; retrying in ${delay}ms: ${errorMessage(error)}`)
        }
      }
    } finally {
      this.acking = false
      this.scheduleAckRetry()
    }
  }

  private scheduleAckRetry(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    if (!this.online || this.pendingAcks.size === 0) return
    const now = Date.now()
    let next = Infinity
    for (const scope of this.pendingAcks.keys()) next = Math.min(next, this.ackBackoff.get(scope)?.retryAt ?? now)
    this.deps.detach(() => {
      this.ackTimer = setTimeout(() => {
        this.ackTimer = null
        this.flushAcks()
      }, Math.max(0, next - now))
      this.ackTimer.unref?.()
    })
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
