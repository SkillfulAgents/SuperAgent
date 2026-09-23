import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetPlatformAccessToken = vi.fn<() => string | null>()
const mockDecodeOrgIdFromToken = vi.fn<(token: string) => string | null>()
const mockCaptureException = vi.fn()

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))
vi.mock('@shared/lib/platform-auth/decode-org-id', () => ({
  decodeOrgIdFromToken: (token: string) => mockDecodeOrgIdFromToken(token),
}))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.test',
}))
vi.mock('@shared/lib/error-reporting', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}))

import {
  PlatformRelayError,
  acknowledgePlatformRelayEvents,
  claimPlatformRelayEvents,
} from './platform-relay-client'

const mockFetch = vi.fn()
let originalFetch: typeof globalThis.fetch

function lastRequest(): { url: string; body: unknown; authorization: string | null } {
  const [url, init] = mockFetch.mock.calls.at(-1) as [string, RequestInit]
  return {
    url,
    body: JSON.parse(init.body as string),
    authorization: new Headers(init.headers).get('Authorization'),
  }
}

const realtime = { url: 'wss://rt.test', apikey: 'anon', jwt: 'jwt-1', channel: 'realtime:public:webhook_events' }

beforeEach(() => {
  vi.clearAllMocks()
  originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch
  mockGetPlatformAccessToken.mockReturnValue('token-value')
  mockDecodeOrgIdFromToken.mockReturnValue(null)
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('claimPlatformRelayEvents', () => {
  it('sends the endpoint ids and an org bearer carrying the member scope', async () => {
    mockDecodeOrgIdFromToken.mockReturnValue('org_1')
    mockFetch.mockResolvedValue(Response.json({ events: [], realtime: null }))

    await claimPlatformRelayEvents('sub_member_1', ['whep_a', 'ti_b'])

    expect(lastRequest()).toEqual({
      url: 'https://proxy.test/v1/webhook-events/poll',
      body: { trigger_ids: ['whep_a', 'ti_b'] },
      authorization: 'Bearer token-value::sub_member_1',
    })
  })

  it('sends an opaque key unchanged', async () => {
    mockFetch.mockResolvedValue(Response.json({ events: [], realtime: null }))

    await claimPlatformRelayEvents('local', ['whep_a'])

    expect(lastRequest().authorization).toBe('Bearer token-value')
  })

  it('maps rows to relay events and returns the realtime credentials', async () => {
    mockFetch.mockResolvedValue(Response.json({
      events: [{ id: 'whe_1', composio_trigger_id: 'whep_a', trigger_type: 'CUSTOM_WEBHOOK', payload: { ok: true }, created_at: 't' }],
      realtime,
    }))

    const claim = await claimPlatformRelayEvents('local', ['whep_a'])

    expect(claim).toEqual({
      events: [{ id: 'whe_1', endpointId: 'whep_a', type: 'CUSTOM_WEBHOOK', payload: { ok: true }, createdAt: 't' }],
      claimed: 1,
      realtime,
    })
  })

  it('drops a malformed row but still counts it as claimed', async () => {
    mockFetch.mockResolvedValue(Response.json({
      events: [
        { id: 'whe_1', trigger_type: 'CUSTOM_WEBHOOK', payload: {}, created_at: 't' },
        { id: 'whe_2', composio_trigger_id: 'whep_a', trigger_type: 'CUSTOM_WEBHOOK', payload: {}, created_at: 't' },
      ],
      realtime: null,
    }))

    const claim = await claimPlatformRelayEvents('local', ['whep_a'])

    expect(claim.events.map((event) => event.id)).toEqual(['whe_2'])
    expect(claim.claimed).toBe(2)
    expect(mockCaptureException).toHaveBeenCalledTimes(1)
  })

  it('keeps the claimed events when the realtime block is malformed', async () => {
    mockFetch.mockResolvedValue(Response.json({
      events: [{ id: 'whe_1', composio_trigger_id: 'whep_a', trigger_type: 'CUSTOM_WEBHOOK', payload: {}, created_at: 't' }],
      realtime: { ...realtime, apikey: '' },
    }))

    const claim = await claimPlatformRelayEvents('local', ['whep_a'])

    expect(claim.events.map((event) => event.id)).toEqual(['whe_1'])
    expect(claim.realtime).toBeNull()
    expect(mockCaptureException).toHaveBeenCalledTimes(1)
  })

  it('throws a PlatformRelayError with the status on failure', async () => {
    mockFetch.mockResolvedValue(new Response('member gone', { status: 403 }))

    const error = await claimPlatformRelayEvents('sub_gone', ['whep_a']).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(PlatformRelayError)
    expect(error).toMatchObject({ status: 403 })
  })

  it('throws without calling the platform when there is no token', async () => {
    mockGetPlatformAccessToken.mockReturnValue(null)

    await expect(claimPlatformRelayEvents('local', ['whep_a'])).rejects.toBeInstanceOf(PlatformRelayError)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('acknowledgePlatformRelayEvents', () => {
  it('posts the event ids under the claiming scope', async () => {
    mockDecodeOrgIdFromToken.mockReturnValue('org_1')
    mockFetch.mockResolvedValue(Response.json({ ok: true, acknowledged: 2 }))

    await acknowledgePlatformRelayEvents('sub_member_1', ['whe_1', 'whe_2'])

    expect(lastRequest()).toEqual({
      url: 'https://proxy.test/v1/webhook-events/ack',
      body: { event_ids: ['whe_1', 'whe_2'] },
      authorization: 'Bearer token-value::sub_member_1',
    })
  })

  it('does nothing for an empty list', async () => {
    await acknowledgePlatformRelayEvents('local', [])

    expect(mockFetch).not.toHaveBeenCalled()
  })
})
