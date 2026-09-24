import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import type { RealtimeConfig } from '@shared/lib/services/supabase-realtime-client'
import type { PlatformClaim } from './platform-relay-client'
import { WebhookRelayUnavailableError } from './errors'
import {
  PlatformWebhookRelayService,
  type PlatformEndpointsApi,
  type PlatformWebhookRelayDeps,
  type PlatformWebhookRelayOptions,
  type RealtimeConnection,
} from './platform-webhook-relay-service'
import { UnavailableWebhookRelayService } from './unavailable-webhook-relay-service'
import { LOCAL_RELAY_SCOPE, type RelayAcceptResult, type RelayConsumer, type RelayEvent } from './types'

// ============================================================================
// Fakes
// ============================================================================

/** The platform queue: claims are final and scoped by member + endpoint ids, as on the proxy. */
class FakePlatform {
  pending = new Map<string, RelayEvent[]>()
  claims: Array<{ scope: string; endpointIds: string[] }> = []
  acks: Array<{ scope: string; ids: string[] }> = []
  failingScopes = new Set<string>()
  failAcks = 0
  failAckScopes = new Set<string>()
  ackGate: Promise<void> | null = null
  signals: AbortSignal[] = []
  realtimeEnabled = true
  claimGate: Promise<void> | null = null
  private nextId = 0
  private nextJwt = 0

  add(scope: string, endpointId: string, count = 1): RelayEvent[] {
    const added: RelayEvent[] = []
    for (let i = 0; i < count; i++) {
      const event = { id: `whe_${++this.nextId}`, endpointId, type: 'CUSTOM_WEBHOOK', payload: { n: this.nextId }, createdAt: '' }
      added.push(event)
    }
    this.pending.set(scope, [...(this.pending.get(scope) ?? []), ...added])
    return added
  }

  claim = vi.fn(async (scope: string, endpointIds: readonly string[], signal?: AbortSignal): Promise<PlatformClaim> => {
    this.claims.push({ scope, endpointIds: [...endpointIds] })
    if (signal) this.signals.push(signal)
    if (this.claimGate) await this.claimGate
    if (this.failingScopes.has(scope)) throw new Error(`claim failed for ${scope}`)
    const taken: RelayEvent[] = []
    const rest: RelayEvent[] = []
    for (const event of this.pending.get(scope) ?? []) {
      if (taken.length < 50 && endpointIds.includes(event.endpointId)) taken.push(event)
      else rest.push(event)
    }
    this.pending.set(scope, rest)
    const realtime: RealtimeConfig | null = this.realtimeEnabled
      ? { url: 'wss://rt.test', apikey: 'anon', jwt: `jwt-${++this.nextJwt}`, channel: 'realtime:public:webhook_events' }
      : null
    return { events: taken, claimed: taken.length, realtime }
  })

  acknowledge = vi.fn(async (scope: string, ids: readonly string[]) => {
    if (this.ackGate) await this.ackGate
    if (this.failAckScopes.has(scope)) throw new Error(`ack failed for ${scope}`)
    if (this.failAcks > 0) {
      this.failAcks--
      throw new Error('ack failed')
    }
    this.acks.push({ scope, ids: [...ids] })
  })

  ackedIds(): string[] {
    return this.acks.flatMap((ack) => ack.ids)
  }
}

class FakeRealtime implements RealtimeConnection {
  active = false
  disconnected = false
  jwts: string[] = []
  onInsert: ((record: unknown) => void) | null = null
  onDisconnect: (() => void) | null = null
  onConnect: (() => void) | null = null

  async connect(
    config: RealtimeConfig,
    onInsert: (record: unknown) => void,
    onDisconnect?: () => void,
    onConnect?: () => void,
  ) {
    this.onInsert = onInsert
    this.onDisconnect = onDisconnect ?? null
    this.onConnect = onConnect ?? null
    this.jwts.push(config.jwt)
    this.active = true
    this.onConnect?.()
  }
  disconnect() {
    this.active = false
    this.disconnected = true
  }
  isActive() {
    return this.active
  }
  async updateToken(jwt: string) {
    this.jwts.push(jwt)
  }
  drop() {
    this.active = false
    this.onDisconnect?.()
  }
  /** The socket's own reconnect, with the credentials it already had. */
  reconnect() {
    this.active = true
    this.onConnect?.()
  }
}

let platform: FakePlatform
let sockets: FakeRealtime[]
let token: string | null
let orgToken: boolean
let relay: PlatformWebhookRelayService
let endpoints: { [K in keyof PlatformEndpointsApi]: ReturnType<typeof vi.fn> }

function deps(overrides: Partial<PlatformWebhookRelayDeps> = {}): PlatformWebhookRelayDeps {
  return {
    claim: platform.claim,
    acknowledge: platform.acknowledge,
    endpoints: endpoints as unknown as PlatformEndpointsApi,
    getToken: () => token,
    requiresMemberScope: () => orgToken,
    createRealtime: () => {
      const socket = new FakeRealtime()
      sockets.push(socket)
      return socket
    },
    detach: (fn) => fn(),
    ...overrides,
  }
}

function createRelay(options: PlatformWebhookRelayOptions = {}, overrides: Partial<PlatformWebhookRelayDeps> = {}) {
  relay = new PlatformWebhookRelayService(deps(overrides), options)
  return relay
}

function startRelay(options: PlatformWebhookRelayOptions = {}, overrides: Partial<PlatformWebhookRelayDeps> = {}) {
  createRelay(options, overrides).start()
  return relay
}

function consumer(
  endpointIds: string[],
  accept: RelayConsumer['accept'] = async () => 'accepted',
  scope = 'sub_a',
  id = `consumer:${scope}:${endpointIds.join(',')}`,
): RelayConsumer & { accept: ReturnType<typeof vi.fn> } {
  return { id, scope, endpointIds, accept: vi.fn(accept) }
}

async function settle() {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  platform = new FakePlatform()
  sockets = []
  token = 'plat_sa_token'
  orgToken = false
  endpoints = {
    create: vi.fn(async () => ({ id: 'whep_new', url: 'https://relay.test/v1/hooks/whep_new' })),
    update: vi.fn(async () => ({ id: 'whep_new' })),
    disable: vi.fn(async () => {}),
    listEvents: vi.fn(async () => ({ filterExp: null, events: [] })),
    testFilter: vi.fn(async () => ({})),
  }
})

afterEach(() => {
  relay?.stop()
  vi.useRealTimers()
})

// ============================================================================
// Tests
// ============================================================================

describe('PlatformWebhookRelayService', () => {
  describe('claiming and acknowledgement', () => {
    it('claims nothing and reports idle while nothing is registered', async () => {
      startRelay()
      await settle()
      await vi.advanceTimersByTimeAsync(10 * 60_000)

      expect(platform.claim).not.toHaveBeenCalled()
      expect(relay.snapshot()).toMatchObject({ available: true, transport: 'idle' })
    })

    it("claims a consumer's endpoints under its scope and acks what it accepts", async () => {
      startRelay()
      const [event] = platform.add('sub_a', 'whep_one')
      const c = consumer(['whep_one'])
      relay.register(c)
      await settle()

      expect(platform.claims[0]).toEqual({ scope: 'sub_a', endpointIds: ['whep_one'] })
      expect(c.accept).toHaveBeenCalledWith([event])
      expect(platform.acks).toEqual([{ scope: 'sub_a', ids: [event.id] }])
      expect(relay.snapshot()).toMatchObject({ available: true, transport: 'realtime', lastError: null })
    })

    it('acks duplicate and discard results too', async () => {
      startRelay()
      const [a, b, c] = platform.add('sub_a', 'whep_one', 3)
      relay.register(consumer(['whep_one'], async () => new Map<string, RelayAcceptResult>([
        [a.id, 'accepted'], [b.id, 'duplicate'], [c.id, 'discard'],
      ])))
      await settle()

      expect(platform.ackedIds()).toEqual([a.id, b.id, c.id])
    })

    it('keeps claiming until a batch comes back short', async () => {
      startRelay()
      platform.realtimeEnabled = false
      await settle()
      platform.add('sub_a', 'whep_one', 120)
      relay.register(consumer(['whep_one']))
      await settle()

      // One round: 50 + 50 + 20.
      expect(platform.claims).toHaveLength(3)
      expect(platform.ackedIds()).toHaveLength(120)
    })

    it('splits more than 500 endpoints across claims and never sends an invalid id', async () => {
      startRelay()
      const ids = Array.from({ length: 600 }, (_, i) => `whep_${i}`)
      relay.register(consumer([...ids, 'not-an-endpoint']))
      await settle()

      const first = platform.claims.slice(0, 2).map((claim) => claim.endpointIds)
      expect(first.map((chunk) => chunk.length)).toEqual([500, 100])
      expect(first.flat()).not.toContain('not-an-endpoint')
    })

    it('offers a retry again after backoff and never acks it until it settles', async () => {
      startRelay({ retryDelaysMs: [5_000] })
      const [event] = platform.add('sub_a', 'whep_one')
      const results: RelayAcceptResult[] = ['retry', 'accepted']
      const c = consumer(['whep_one'], async () => results.shift()!)
      relay.register(c)
      await settle()

      expect(c.accept).toHaveBeenCalledTimes(1)
      expect(platform.acks).toEqual([])

      await vi.advanceTimersByTimeAsync(5_000)
      await settle()
      expect(c.accept).toHaveBeenCalledTimes(2)
      expect(platform.ackedIds()).toEqual([event.id])
    })

    it('acks the settled events of a batch and retries only the rest', async () => {
      startRelay({ retryDelaysMs: [5_000] })
      const [a, b] = platform.add('sub_a', 'whep_one', 2)
      const c = consumer(['whep_one'], async (events) =>
        events.length === 2 ? new Map([[a.id, 'accepted' as const]]) : 'accepted',
      )
      relay.register(c)
      await settle()
      expect(platform.ackedIds()).toEqual([a.id])

      await vi.advanceTimersByTimeAsync(5_000)
      await settle()
      expect(c.accept).toHaveBeenLastCalledWith([b])
      expect(platform.ackedIds()).toEqual([a.id, b.id])
    })

    it('keeps delivering fresh events while one of them keeps retrying', async () => {
      startRelay({ retryDelaysMs: [10 * 60_000] })
      const [stuck] = platform.add('sub_a', 'whep_one')
      const c = consumer(['whep_one'], async (events) =>
        new Map(events.map((event) => [event.id, event.id === stuck.id ? 'retry' as const : 'accepted' as const])),
      )
      relay.register(c)
      await settle()

      const [fresh] = platform.add('sub_a', 'whep_two')
      relay.register(consumer(['whep_two'], async () => 'accepted', 'sub_a', 'other'))
      const [next] = platform.add('sub_a', 'whep_one')
      relay.wake()
      await settle()

      // No time has passed: the stuck event's backoff held back nothing else.
      expect(platform.ackedIds()).toEqual(expect.arrayContaining([fresh.id, next.id]))
      expect(platform.ackedIds()).not.toContain(stuck.id)
      expect(c.accept).toHaveBeenLastCalledWith([next])
    })

    it('offers waiting retries again at once on retryNow', async () => {
      startRelay({ retryDelaysMs: [10 * 60_000] })
      const [event] = platform.add('sub_a', 'whep_one')
      const results: RelayAcceptResult[] = ['retry', 'accepted']
      const c = consumer(['whep_one'], async () => results.shift()!)
      const handle = relay.register(c)
      await settle()
      expect(platform.acks).toEqual([])

      handle.retryNow()
      await settle()

      expect(c.accept).toHaveBeenCalledTimes(2)
      expect(platform.ackedIds()).toEqual([event.id])
    })

    it('treats a throwing consumer as a retry', async () => {
      startRelay({ retryDelaysMs: [5_000] })
      platform.add('sub_a', 'whep_one')
      let calls = 0
      relay.register(consumer(['whep_one'], async () => {
        if (++calls === 1) throw new Error('db busy')
        return 'accepted'
      }))
      await settle()
      expect(platform.acks).toEqual([])

      await vi.advanceTimersByTimeAsync(5_000)
      await settle()
      expect(platform.ackedIds()).toHaveLength(1)
    })

    it('delivers a claim that was in flight when its consumer let go', async () => {
      startRelay()
      const [event] = platform.add('sub_a', 'whep_one')
      const gate = deferred()
      platform.claimGate = gate.promise
      const c = consumer(['whep_one'])
      const handle = relay.register(c)
      await settle()

      handle.dispose()
      gate.resolve()
      platform.claimGate = null
      await settle()

      expect(c.accept).toHaveBeenCalledWith([event])
      expect(platform.ackedIds()).toEqual([event.id])
    })

    it('delivers a claim in flight during a replacement under another scope to the consumer that sent it', async () => {
      startRelay()
      platform.realtimeEnabled = false
      await settle()
      const [event] = platform.add('local', 'whep_one')
      const gate = deferred()
      platform.claimGate = gate.promise
      const old = consumer(['whep_one'], undefined, 'local', 'webhook-triggers:local')
      const handle = relay.register(old)
      await settle()

      // Auth resolves the scope to a member while the claim is outstanding.
      handle.dispose()
      const replacement = consumer(['whep_one'], undefined, 'sub_member', 'webhook-triggers:sub_member')
      relay.register(replacement)
      platform.claimGate = null
      gate.resolve()
      await settle()

      expect(old.accept).toHaveBeenCalledWith([event])
      expect(replacement.accept).not.toHaveBeenCalled()
      expect(platform.ackedIds()).toEqual([event.id])
    })

    it('delivers a claim answering after its deadline to the consumer that sent it, even if replaced meanwhile', async () => {
      startRelay({ requestTimeoutMs: 10_000 })
      platform.realtimeEnabled = false
      await settle()
      const [event] = platform.add('local', 'whep_one')
      const slow = deferred()
      platform.claimGate = slow.promise
      const old = consumer(['whep_one'], undefined, 'local', 'old')
      const handle = relay.register(old)
      await settle()
      await vi.advanceTimersByTimeAsync(10_000)

      handle.dispose()
      relay.register(consumer(['whep_one'], undefined, 'sub_member', 'new'))
      platform.claimGate = null
      slow.resolve()
      await settle()

      expect(old.accept).toHaveBeenCalledWith([event])
      expect(platform.ackedIds()).toEqual([event.id])
    })

    it('still delivers everything already claimed for a consumer it replaces', async () => {
      startRelay()
      platform.realtimeEnabled = false
      await settle()
      platform.add('local', 'whep_one', 120)
      const gate = deferred()
      let calls = 0
      const old = consumer(['whep_one'], async () => {
        if (++calls === 1) await gate.promise
        return 'accepted'
      }, 'local', 'webhook-triggers:local')
      const handle = relay.register(old)
      await settle()
      // All 120 are claimed and queued; the first batch of 50 is being accepted.
      expect(platform.pending.get('local')).toEqual([])

      // Auth resolves the scope to a member: the registration is replaced.
      handle.dispose()
      const replacement = consumer(['whep_one'], undefined, 'sub_member', 'webhook-triggers:sub_member')
      relay.register(replacement)
      gate.resolve()
      await settle()

      expect(old.accept).toHaveBeenCalledTimes(3)
      expect(platform.ackedIds()).toHaveLength(120)
      expect(new Set(platform.ackedIds()).size).toBe(120)
      expect(replacement.accept).not.toHaveBeenCalled()
    })

    it('acks what a consumer settled even if it let go during accept', async () => {
      startRelay()
      const [event] = platform.add('sub_a', 'whep_one')
      const gate = deferred()
      const handle = relay.register(consumer(['whep_one'], async () => {
        await gate.promise
        return 'accepted'
      }))
      await settle()

      handle.dispose()
      gate.resolve()
      await settle()

      expect(platform.ackedIds()).toEqual([event.id])
    })

    it('stops claiming an endpoint as soon as its consumer lets go, mid-round', async () => {
      createRelay()
      platform.realtimeEnabled = false
      platform.add('sub_a', 'whep_a', 60)
      const gate = deferred()
      platform.claimGate = gate.promise
      relay.register(consumer(['whep_a'], undefined, 'sub_a', 'a'))
      const b = relay.register(consumer(['whep_b'], undefined, 'sub_a', 'b'))
      relay.start()
      await settle()
      expect(platform.claims[0].endpointIds).toEqual(['whep_a', 'whep_b'])

      b.dispose()
      platform.claimGate = null
      gate.resolve()
      await settle()

      // The first batch came back full, so the lane claims again, without whep_b.
      expect(platform.claims[1].endpointIds).toEqual(['whep_a'])
    })

    it('retries a failed ack after backoff', async () => {
      startRelay({ retryDelaysMs: [5_000] })
      platform.realtimeEnabled = false
      platform.failAcks = 1
      const [event] = platform.add('sub_a', 'whep_one')
      relay.register(consumer(['whep_one']))
      await settle()
      expect(platform.acks).toEqual([])

      await vi.advanceTimersByTimeAsync(5_000)
      await settle()
      expect(platform.ackedIds()).toEqual([event.id])
    })

    it('never drops a pending ack; claiming for the scope pauses until acks drain', async () => {
      startRelay({ requestTimeoutMs: 60 * 60_000 })
      platform.realtimeEnabled = false
      const slowAck = deferred()
      platform.ackGate = slowAck.promise
      platform.add('sub_a', 'whep_one', 1500)
      relay.register(consumer(['whep_one']))
      await settle()

      // Claims stopped once 1,000 acks were waiting, instead of claiming on
      // and dropping the oldest ids.
      expect(platform.pending.get('sub_a')!.length).toBeGreaterThan(0)
      expect(platform.acknowledge).toHaveBeenCalledTimes(1)

      platform.ackGate = null
      slowAck.resolve()
      await settle()

      const acked = platform.ackedIds()
      expect(acked).toHaveLength(1500)
      expect(new Set(acked).size).toBe(1500)
      expect(platform.pending.get('sub_a')).toEqual([])
    })

    it("keeps acking other scopes while one scope's acks fail", async () => {
      startRelay()
      platform.failAckScopes.add('sub_bad')
      platform.add('sub_bad', 'whep_bad')
      const [good] = platform.add('sub_good', 'whep_good')
      relay.register(consumer(['whep_bad'], undefined, 'sub_bad'))
      relay.register(consumer(['whep_good'], undefined, 'sub_good'))
      await settle()

      expect(platform.ackedIds()).toEqual([good.id])
    })

    it('keeps claiming and delivering while an ack hangs, then times it out and retries', async () => {
      startRelay({ requestTimeoutMs: 10_000, retryDelaysMs: [5_000], tickMs: 60_000 })
      const hang = deferred()
      platform.ackGate = hang.promise
      const [first] = platform.add('sub_a', 'whep_one')
      const c = consumer(['whep_one'])
      relay.register(c)
      await settle()
      const [socket] = sockets

      const [second] = platform.add('sub_a', 'whep_one')
      socket.onInsert?.({ composio_trigger_id: 'whep_one', status: 'pending' })
      await settle()
      expect(c.accept).toHaveBeenLastCalledWith([second])
      expect(platform.acks).toEqual([])

      platform.ackGate = null
      await vi.advanceTimersByTimeAsync(10_000 + 5_000)
      await settle()
      expect(platform.ackedIds().sort()).toEqual([first.id, second.id].sort())
    })
  })

  describe('scheduling', () => {
    it('gives every scope a turn while another keeps returning full batches', async () => {
      createRelay({ maxClaimsPerTurn: 2 })
      platform.realtimeEnabled = false
      platform.add('sub_busy', 'whep_busy', 300)
      const [quiet] = platform.add('sub_quiet', 'whep_quiet')
      relay.register(consumer(['whep_busy'], undefined, 'sub_busy'))
      relay.register(consumer(['whep_quiet'], undefined, 'sub_quiet'))
      relay.start()
      await settle()

      const scopes = platform.claims.map((claim) => claim.scope)
      expect(scopes.slice(0, 3)).toEqual(['sub_busy', 'sub_busy', 'sub_quiet'])
      expect(platform.ackedIds()).toContain(quiet.id)
      // The busy scope still drains, a turn at a time.
      expect(platform.ackedIds()).toHaveLength(301)
    })

    it('times out a hung claim and claims again on the next tick', async () => {
      startRelay({ requestTimeoutMs: 10_000, tickMs: 30_000 })
      platform.realtimeEnabled = false
      await settle()
      platform.claimGate = new Promise(() => {})
      relay.register(consumer(['whep_one']))
      await settle()

      await vi.advanceTimersByTimeAsync(10_000)
      await settle()
      expect(relay.snapshot()).toMatchObject({ transport: 'unreachable' })
      expect(relay.snapshot().lastError).toMatch(/timed out/)

      platform.claimGate = null
      const [event] = platform.add('sub_a', 'whep_one')
      await vi.advanceTimersByTimeAsync(30_000)
      await settle()
      expect(platform.ackedIds()).toEqual([event.id])
      expect(relay.snapshot().transport).toBe('polling')
    })

    it('still delivers a claim that answers after its deadline', async () => {
      startRelay({ requestTimeoutMs: 10_000 })
      platform.realtimeEnabled = false
      await settle()
      const [event] = platform.add('sub_a', 'whep_one')
      const slow = deferred()
      platform.claimGate = slow.promise
      const c = consumer(['whep_one'])
      relay.register(c)
      await settle()

      await vi.advanceTimersByTimeAsync(10_000)
      await settle()
      expect(relay.snapshot().transport).toBe('unreachable')
      expect(c.accept).not.toHaveBeenCalled()

      // The platform had claimed it; the answer turns up late.
      platform.claimGate = null
      slow.resolve()
      await settle()
      expect(c.accept).toHaveBeenCalledWith([event])
      expect(platform.ackedIds()).toEqual([event.id])
    })

    it('coalesces wakes during a round into one more round', async () => {
      startRelay()
      platform.realtimeEnabled = false
      const gate = deferred()
      platform.claimGate = gate.promise
      relay.register(consumer(['whep_one']))
      await settle()
      expect(platform.claims).toHaveLength(1)

      for (let i = 0; i < 5; i++) relay.wake()
      platform.claimGate = null
      gate.resolve()
      await settle()

      expect(platform.claims).toHaveLength(2)
    })

    it('wakes on a realtime insert for its own pending endpoints only', async () => {
      startRelay()
      relay.register(consumer(['whep_one']))
      await settle()
      const socket = sockets[0]
      const before = platform.claims.length

      socket.onInsert?.({ composio_trigger_id: 'whep_someone_else', status: 'pending' })
      socket.onInsert?.({ composio_trigger_id: 'whep_one', status: 'filtered' })
      await settle()
      expect(platform.claims).toHaveLength(before)

      platform.add('sub_a', 'whep_one')
      socket.onInsert?.({ composio_trigger_id: 'whep_one', status: 'pending' })
      await settle()
      expect(platform.claims).toHaveLength(before + 1)
      expect(platform.ackedIds()).toHaveLength(1)
    })

    it('claims again right after realtime connects', async () => {
      startRelay()
      await settle()
      relay.register(consumer(['whep_one']))
      await settle()

      // The registration's claim, then the one covering the subscribe gap.
      expect(sockets).toHaveLength(1)
      expect(platform.claims).toHaveLength(2)
    })

    it('polls every tick while realtime is down', async () => {
      startRelay({ tickMs: 30_000 })
      platform.realtimeEnabled = false
      relay.register(consumer(['whep_one']))
      await settle()
      expect(relay.snapshot().transport).toBe('polling')
      const before = platform.claims.length

      await vi.advanceTimersByTimeAsync(90_000)
      await settle()
      expect(platform.claims.length - before).toBe(3)
    })

    it('only reconciles while realtime is up', async () => {
      startRelay({ tickMs: 30_000, reconcileMs: 5 * 60_000 })
      relay.register(consumer(['whep_one']))
      await settle()
      const before = platform.claims.length

      await vi.advanceTimersByTimeAsync(4 * 60_000)
      await settle()
      expect(platform.claims).toHaveLength(before)

      await vi.advanceTimersByTimeAsync(60_000)
      await settle()
      expect(platform.claims).toHaveLength(before + 1)
    })

    it('catches up when the socket reconnects by itself', async () => {
      startRelay({ tickMs: 30_000 })
      relay.register(consumer(['whep_one']))
      await settle()
      const [socket] = sockets

      socket.drop()
      const [missed] = platform.add('sub_a', 'whep_one')
      socket.reconnect()
      await settle()

      expect(platform.ackedIds()).toContain(missed.id)
      expect(sockets).toHaveLength(1)
    })

    it('reconnects realtime with fresh credentials after it drops', async () => {
      startRelay({ tickMs: 30_000 })
      relay.register(consumer(['whep_one']))
      await settle()
      const [first] = sockets

      first.drop()
      expect(relay.snapshot().transport).toBe('polling')
      await vi.advanceTimersByTimeAsync(30_000)
      await settle()

      expect(first.disconnected).toBe(true)
      expect(sockets).toHaveLength(2)
      expect(sockets[1].jwts[0]).not.toBe(first.jwts[0])
      expect(relay.snapshot().transport).toBe('realtime')
    })

    it('hands the socket a fresh token once the old one is getting old', async () => {
      startRelay({ tickMs: 30_000, reconcileMs: 5 * 60_000, realtimeTokenRefreshMs: 40 * 60_000 })
      relay.register(consumer(['whep_one']))
      await settle()
      const [socket] = sockets
      expect(socket.jwts).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(45 * 60_000)
      await settle()

      expect(sockets).toHaveLength(1)
      expect(socket.jwts.length).toBe(2)
    })

    it('stops claiming for a consumer whose backlog is full until it catches up', async () => {
      startRelay({ maxConsumerBacklog: 2 })
      platform.realtimeEnabled = false
      const gate = deferred()
      const c = consumer(['whep_slow'], async () => {
        await gate.promise
        return 'accepted'
      })
      relay.register(c)
      platform.add('sub_a', 'whep_slow', 3)
      relay.wake()
      await settle()
      const claimsWhileFull = platform.claims.length

      platform.add('sub_a', 'whep_slow')
      relay.wake()
      await settle()
      expect(platform.claims).toHaveLength(claimsWhileFull)

      gate.resolve()
      await settle()
      expect(platform.claims.length).toBeGreaterThan(claimsWhileFull)
      expect(platform.ackedIds()).toHaveLength(4)
    })

    it('resumes claiming as soon as a consumer that filled up during accept catches up', async () => {
      startRelay({ maxConsumerBacklog: 3, tickMs: 30_000, reconcileMs: 5 * 60_000 })
      const gate = deferred()
      let calls = 0
      const c = consumer(['whep_one'], async () => {
        if (++calls === 1) await gate.promise
        return 'accepted'
      })
      platform.add('sub_a', 'whep_one', 2)
      relay.register(c)
      await settle()
      const [socket] = sockets
      const notify = () => socket.onInsert?.({ composio_trigger_id: 'whep_one', status: 'pending' })

      // While the first batch is being accepted, the queue fills up...
      platform.add('sub_a', 'whep_one')
      notify()
      await settle()
      // ...so this claim is held back.
      platform.add('sub_a', 'whep_one', 50)
      notify()
      await settle()
      expect(platform.pending.get('sub_a')).toHaveLength(50)

      gate.resolve()
      await settle()

      // No new notification and no reconciliation: draining the consumer
      // has to restart claiming by itself.
      expect(platform.pending.get('sub_a')).toEqual([])
      expect(platform.ackedIds()).toHaveLength(53)
    })

    it("starts claims outside the caller's request scope", async () => {
      const { runOutsideRequestUser, runWithRequestUser, getRequestUserId } = await import(
        '@shared/lib/platform-attribution/request-context'
      )
      const seen: Array<string | undefined> = []
      startRelay({}, {
        detach: runOutsideRequestUser,
        claim: async (scope, ids) => {
          seen.push(getRequestUserId())
          return platform.claim(scope, ids)
        },
      })
      await settle()
      await runWithRequestUser('user_in_a_request', async () => {
        relay.register(consumer(['whep_one']))
      })
      await settle()

      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((userId) => userId === undefined)).toBe(true)
    })
  })

  describe('consumers', () => {
    it('refuses a second owner for an endpoint within a scope', () => {
      startRelay()
      relay.register(consumer(['whep_one'], undefined, 'sub_a', 'first'))

      expect(() => relay.register(consumer(['whep_one'], undefined, 'sub_a', 'second'))).toThrow(/already belongs to first/)
      expect(() => relay.register(consumer(['whep_one'], undefined, 'sub_b', 'other-scope'))).not.toThrow()
    })

    it('claims newly added endpoints after an update', async () => {
      startRelay()
      platform.realtimeEnabled = false
      const handle = relay.register(consumer(['whep_one']))
      await settle()

      handle.update({ endpointIds: ['whep_one', 'whep_two'] })
      await settle()

      expect(platform.claims.at(-1)?.endpointIds).toEqual(['whep_one', 'whep_two'])
    })

    it('drops realtime once nothing is registered', async () => {
      startRelay()
      const handle = relay.register(consumer(['whep_one']))
      await settle()

      handle.dispose()
      expect(sockets[0].disconnected).toBe(true)
      expect(relay.snapshot().transport).toBe('idle')
    })
  })

  describe('scopes and health', () => {
    it("keeps delivering other scopes when one member's claims fail", async () => {
      startRelay()
      platform.failingScopes.add('sub_gone')
      const [event] = platform.add('sub_a', 'whep_one')
      relay.register(consumer(['whep_one'], undefined, 'sub_a'))
      relay.register(consumer(['whep_two'], undefined, 'sub_gone'))
      await settle()

      expect(platform.ackedIds()).toEqual([event.id])
      expect(relay.snapshot()).toMatchObject({ transport: 'realtime', lastError: null })
    })

    it('reports unreachable with the error when every claim fails', async () => {
      startRelay()
      platform.failingScopes.add('sub_a')
      relay.register(consumer(['whep_one']))
      await settle()

      expect(relay.snapshot()).toMatchObject({
        available: true,
        transport: 'unreachable',
        lastError: 'claim failed for sub_a',
      })
    })

    it('never claims the local scope with an org token, and reports idle rather than connecting', async () => {
      orgToken = true
      startRelay()
      relay.register(consumer(['whep_one'], undefined, LOCAL_RELAY_SCOPE))
      await settle()

      expect(platform.claim).not.toHaveBeenCalled()
      expect(relay.snapshot()).toMatchObject({ available: true, transport: 'idle' })
    })
  })

  describe('stop and start', () => {
    it('suspends retries and delivery on stop, and resumes them on start', async () => {
      startRelay({ retryDelaysMs: [5_000] })
      platform.add('sub_a', 'whep_one')
      const results: RelayAcceptResult[] = ['retry', 'accepted']
      const c = consumer(['whep_one'], async () => results.shift()!)
      relay.register(c)
      await settle()
      expect(c.accept).toHaveBeenCalledTimes(1)

      relay.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(c.accept).toHaveBeenCalledTimes(1)

      relay.start()
      await settle()
      expect(c.accept).toHaveBeenCalledTimes(2)
      expect(platform.ackedIds()).toHaveLength(1)
    })

    it('does not start the next batch when one finishes after stop', async () => {
      startRelay()
      platform.realtimeEnabled = false
      platform.add('sub_a', 'whep_one', 60)
      const gate = deferred()
      const c = consumer(['whep_one'], async () => {
        await gate.promise
        return 'accepted'
      })
      relay.register(c)
      await settle()
      expect(c.accept).toHaveBeenCalledTimes(1)

      relay.stop()
      gate.resolve()
      await settle()

      expect(c.accept).toHaveBeenCalledTimes(1)
    })

    it('cancels in-flight requests on stop', async () => {
      startRelay()
      platform.claimGate = new Promise(() => {})
      relay.register(consumer(['whep_one']))
      await settle()
      const [signal] = platform.signals
      expect(signal.aborted).toBe(false)

      relay.stop()

      expect(signal.aborted).toBe(true)
    })
  })

  describe('endpoints', () => {
    it('provisions endpoints through the platform API in its own vocabulary', async () => {
      startRelay()

      await relay.createEndpoint('sub_a', { name: 'Deploys', filterExp: 'body.ok' })
      await relay.updateEndpoint('sub_a', 'whep_new', { filterExp: null })
      await relay.disableEndpoint('sub_a', 'whep_new')

      expect(endpoints.create).toHaveBeenCalledWith('sub_a', { name: 'Deploys', filter_exp: 'body.ok' })
      expect(endpoints.update).toHaveBeenCalledWith('sub_a', 'whep_new', { filter_exp: null })
      expect(endpoints.disable).toHaveBeenCalledWith('sub_a', 'whep_new')
    })

    it('rejects provisioning while the platform is disconnected', async () => {
      token = null
      startRelay()

      await expect(relay.createEndpoint('sub_a', { name: 'x' })).rejects.toBeInstanceOf(WebhookRelayUnavailableError)
      await expect(relay.createEndpoint('sub_a', { name: 'x' })).rejects.toMatchObject({ reason: 'platform_disconnected' })
      expect(endpoints.create).not.toHaveBeenCalled()
    })

    it('rejects provisioning while stopped, as the snapshot reports', async () => {
      createRelay()
      expect(relay.snapshot()).toMatchObject({ available: false, unavailableReason: 'stopped' })
      await expect(relay.createEndpoint('sub_a', { name: 'x' })).rejects.toMatchObject({ reason: 'stopped' })

      relay.start()
      relay.stop()
      await expect(relay.createEndpoint('sub_a', { name: 'x' })).rejects.toMatchObject({ reason: 'stopped' })
      expect(endpoints.create).not.toHaveBeenCalled()
    })

    it('still takes an endpoint down while stopped, as long as the platform is connected', async () => {
      createRelay()

      await relay.disableEndpoint('sub_a', 'whep_old')
      expect(endpoints.disable).toHaveBeenCalledWith('sub_a', 'whep_old')

      token = null
      await expect(relay.disableEndpoint('sub_a', 'whep_old')).rejects.toMatchObject({ reason: 'platform_disconnected' })
    })

    it('a host with no relay rejects provisioning', async () => {
      const none = new UnavailableWebhookRelayService('not_configured')

      await expect(none.createEndpoint()).rejects.toMatchObject({ reason: 'not_configured' })
    })
  })

  describe('platform auth', () => {
    it('goes unavailable on disconnect, keeps registrations, and resumes on reconnect', async () => {
      startRelay({ tickMs: 30_000 })
      const statuses: string[] = []
      relay.onChange((snapshot) => statuses.push(snapshot.available ? snapshot.transport : 'unavailable'))
      relay.register(consumer(['whep_one']))
      await settle()

      token = null
      relay.onAuthChanged()
      expect(relay.snapshot()).toMatchObject({ available: false, unavailableReason: 'platform_disconnected' })
      expect(sockets[0].disconnected).toBe(true)
      const claimsWhileOffline = platform.claims.length
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(platform.claims).toHaveLength(claimsWhileOffline)

      token = 'plat_sa_token'
      const [event] = platform.add('sub_a', 'whep_one')
      relay.onAuthChanged()
      await settle()
      expect(platform.ackedIds()).toContain(event.id)
      expect(statuses).toContain('unavailable')
      expect(statuses.at(-1)).toBe('realtime')
    })

    it('starts over with a new realtime connection when the token changes', async () => {
      startRelay()
      relay.register(consumer(['whep_one']))
      await settle()
      const [first] = sockets

      token = 'plat_sa_rotated'
      relay.onAuthChanged()
      await settle()

      expect(first.disconnected).toBe(true)
      expect(sockets).toHaveLength(2)
      expect(sockets[1].active).toBe(true)
    })

    it('only nudges a claim when the same token is saved again', async () => {
      startRelay()
      relay.register(consumer(['whep_one']))
      await settle()

      relay.onAuthChanged()
      await settle()

      expect(sockets).toHaveLength(1)
      expect(sockets[0].disconnected).toBe(false)
    })
  })
})
