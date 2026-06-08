import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetPlatformAccessToken = vi.fn()
const mockDecodeOrgIdFromToken = vi.fn()
const mockGetSubscribedComposioTriggerIds = vi.fn()
const mockFetch = vi.fn()
let originalFetch: typeof globalThis.fetch

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))

vi.mock('@shared/lib/platform-attribution', () => ({
  decodeOrgIdFromToken: (token: string) => mockDecodeOrgIdFromToken(token),
}))

vi.mock('@shared/lib/services/webhook-trigger-service', () => ({
  // The poll scope includes paused triggers (still subscribed upstream) so
  // paused-period events are claimed and acked/discarded rather than firing on
  // resume (SUP-225).
  getSubscribedComposioTriggerIds: () => mockGetSubscribedComposioTriggerIds(),
}))

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.test',
}))

import { pollAndClaimEvents } from './webhook-events-client'

describe('webhook-events-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    originalFetch = globalThis.fetch
    mockGetPlatformAccessToken.mockReturnValue('token-value')
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ events: [], realtime: null }), { status: 200 })
    )
    globalThis.fetch = mockFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sends local subscribed trigger_ids in org JWT mode with ::memberId bearer', async () => {
    mockDecodeOrgIdFromToken.mockReturnValue('org_1')
    mockGetSubscribedComposioTriggerIds.mockReturnValue(['ti_host_a', 'ti_host_b'])

    await pollAndClaimEvents('sub_member_1')

    const [, init] = mockFetch.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.trigger_ids).toEqual(['ti_host_a', 'ti_host_b'])
    const headers = (init as RequestInit).headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer token-value::sub_member_1')
  })

  it('sends local subscribed trigger_ids in opaque key mode (no ::memberId suffix)', async () => {
    mockDecodeOrgIdFromToken.mockReturnValue(null)
    mockGetSubscribedComposioTriggerIds.mockReturnValue(['ti_local_a'])

    await pollAndClaimEvents('sub_member_1')

    const [, init] = mockFetch.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.trigger_ids).toEqual(['ti_local_a'])
    const headers = (init as RequestInit).headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer token-value')
  })

  it('sends empty trigger_ids when no local subscribed triggers (proxy short-circuits)', async () => {
    mockGetSubscribedComposioTriggerIds.mockReturnValue([])

    await pollAndClaimEvents('sub_member_1')

    const [, init] = mockFetch.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toEqual({ trigger_ids: [] })
  })
})
