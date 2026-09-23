import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import type { RealtimeConfig } from '@shared/lib/services/supabase-realtime-client'
import type { PlatformClaim } from './platform-relay-client'
import {
  PlatformWebhookRelayService,
  type PlatformWebhookRelayDeps,
  type PlatformWebhookRelayOptions,
  type RealtimeConnection,
} from './platform-webhook-relay-service'
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

  claim = vi.fn(async (scope: string, endpointIds: readonly string[]): Promise<PlatformClaim> => {
    this.claims.push({ scope, endpointIds: [...endpointIds] })
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

function deps(overrides: Partial<PlatformWebhookRelayDeps> = {}): PlatformWebhookRelayDeps {
  return {
    claim: platform.claim,
    acknowledge: platform.acknowledge,
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

function startRelay(options: PlatformWebhookRelayOptions = {}, overrides: Partial<PlatformWebhookRelayDeps> = {}) {
  relay = new PlatformWebhookRelayService(deps(overrides), options)
  relay.start()
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

    it('discards events whose consumer let go of the endpoint mid-claim', async () => {
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

      expect(c.accept).not.toHaveBeenCalled()
      expect(platform.ackedIds()).toEqual([event.id])
    })

    it('retries a failed ack in the next round', async () => {
      startRelay({ tickMs: 30_000 })
      platform.realtimeEnabled = false
      platform.failAcks = 1
      const [event] = platform.add('sub_a', 'whep_one')
      relay.register(consumer(['whep_one']))
      await settle()
      expect(platform.acks).toEqual([])

      await vi.advanceTimersByTimeAsync(30_000)
      await settle()
      expect(platform.ackedIds()).toEqual([event.id])
    })
  })

  describe('scheduling', () => {
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

    it('never claims the local scope with an org token', async () => {
      orgToken = true
      startRelay()
      relay.register(consumer(['whep_one'], undefined, LOCAL_RELAY_SCOPE))
      await settle()

      expect(platform.claim).not.toHaveBeenCalled()
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
