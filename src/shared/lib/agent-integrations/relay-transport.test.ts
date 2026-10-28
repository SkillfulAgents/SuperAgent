import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../services/platform-auth-service', () => ({ getStoredPlatformMemberId: () => null }))
vi.mock('../services/webhook-trigger-service', () => ({ resolvePlatformMemberForCandidates: async () => null }))

import { createFakeWebhookRelay, type FakeWebhookRelay } from '../webhook-relay/testing/fake-webhook-relay'
import type { RelayEvent } from '../webhook-relay'
import { IntegrationRelays, relayAcceptResult } from './relay-transport'
import { readIntegrationRelay, requiresRelay } from './transport'

const binding = { endpointId: 'whep_one', url: 'https://relay.test/v1/hooks/whep_one', scope: 'sub_owner' }
const event = (id: string): RelayEvent => ({ id, endpointId: 'whep_one', type: 'CUSTOM_WEBHOOK', payload: {}, createdAt: '' })

let relay: FakeWebhookRelay
let relays: IntegrationRelays
beforeEach(() => {
  relay = createFakeWebhookRelay()
  relays = new IntegrationRelays(() => relay)
})

describe('IntegrationRelays', () => {
  it('registers one consumer per integration and hands its events to the attached connection', async () => {
    relays.attach('int-1', binding, async () => 'accepted')

    expect(relay.consumers.get('integration:int-1')).toMatchObject({ scope: 'sub_owner', endpointIds: ['whep_one'] })
    expect(await relay.deliver('integration:int-1', [event('whe_1')])).toEqual(new Map([['whe_1', 'accepted']]))
  })

  it('stops claiming while detached, asks for a retry, and offers waiting events to the next connection at once', async () => {
    const first = relays.attach('int-1', binding, async () => 'accepted')
    first.detach()

    expect(relay.consumers.get('integration:int-1')?.endpointIds).toEqual([])
    expect(relays.isAttached('int-1')).toBe(false)
    expect(await relay.deliver('integration:int-1', [event('whe_1')])).toEqual(new Map([['whe_1', 'retry']]))

    relays.attach('int-1', binding, async () => 'duplicate')

    // The same registration, so events claimed across the gap reach the new connection.
    expect(relay.log.filter((entry) => entry.op === 'register')).toHaveLength(1)
    expect(relay.log.at(-1)).toEqual({ op: 'retryNow', id: 'integration:int-1' })
    expect(relay.consumers.get('integration:int-1')?.endpointIds).toEqual(['whep_one'])
    expect(await relay.deliver('integration:int-1', [event('whe_1')])).toEqual(new Map([['whe_1', 'duplicate']]))
  })

  it('ignores a stale connection detaching after a newer one attached', async () => {
    const stale = relays.attach('int-1', binding, async () => 'retry')
    relays.attach('int-1', binding, async () => 'accepted')

    stale.detach()

    expect(relays.isAttached('int-1')).toBe(true)
    expect(await relay.deliver('integration:int-1', [event('whe_1')])).toEqual(new Map([['whe_1', 'accepted']]))
  })

  it('offers a connection the relay only while the host has one available', () => {
    expect(relays.hostFor('int-1')).not.toBeNull()
    relay.setSnapshot({ available: false, unavailableReason: 'platform_disconnected', transport: 'idle', lastClaimAt: null, lastError: null })
    expect(relays.hostFor('int-1')).toBeNull()
  })

  it('reports a superseded attachment as detached', () => {
    const first = relays.attach('int-1', binding, async () => 'accepted')
    const second = relays.attach('int-1', binding, async () => 'accepted')
    expect(first.isAttached()).toBe(false)
    expect(second.isAttached()).toBe(true)
  })

  it('discards what was claimed for a removed integration', async () => {
    relays.attach('int-1', binding, async () => 'retry')
    const [registration] = [...relay.consumers.values()]

    relays.remove('int-1')

    expect(relay.consumers.has('integration:int-1')).toBe(false)
    expect(await registration.accept([event('whe_1')])).toBe('discard')
  })
})

describe('transport helpers', () => {
  it('reads the relay endpoint from any config, and none from a row without webhooks', () => {
    expect(readIntegrationRelay('{"botToken":"x"}')).toBeUndefined()
    expect(readIntegrationRelay({ relay: binding, other: 1 })).toEqual(binding)
    expect(() => readIntegrationRelay('{not json')).toThrow('not valid JSON')
  })

  it('knows which providers need the relay', () => {
    expect(requiresRelay(['relay'])).toBe(true)
    expect(requiresRelay(['direct', 'relay'])).toBe(false)
  })

  it('acknowledges everything but a retry', () => {
    expect(relayAcceptResult('accepted')).toBe('accepted')
    expect(relayAcceptResult('duplicate')).toBe('duplicate')
    expect(relayAcceptResult('rejected')).toBe('discard')
    expect(relayAcceptResult('retry')).toBe('retry')
  })
})
