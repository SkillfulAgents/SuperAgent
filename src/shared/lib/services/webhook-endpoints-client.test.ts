import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetPlatformAccessToken = vi.fn()
const mockDecodeOrgIdFromToken = vi.fn()
const mockFetch = vi.fn()
let originalFetch: typeof globalThis.fetch

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))

vi.mock('@shared/lib/platform-attribution', () => ({
  decodeOrgIdFromToken: (token: string) => mockDecodeOrgIdFromToken(token),
}))

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.test',
}))

import {
  createPlatformWebhookEndpoint,
  updatePlatformWebhookEndpoint,
  disablePlatformWebhookEndpoint,
  listPlatformWebhookEndpoints,
  listPlatformWebhookEvents,
  testPlatformWebhookFilter,
} from './webhook-endpoints-client'

const ENDPOINT = {
  id: 'whep_11111111-2222-4333-8444-555555555555',
  url: 'https://proxy.test/v1/hooks/whep_11111111-2222-4333-8444-555555555555',
  name: 'test endpoint',
  status: 'active',
  verification: null,
  receive_count: 0,
  rejected_count: 0,
  last_received_at: null,
  created_at: '2026-07-06T00:00:00Z',
}

describe('webhook-endpoints-client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    originalFetch = globalThis.fetch
    mockGetPlatformAccessToken.mockReturnValue('token-value')
    mockDecodeOrgIdFromToken.mockReturnValue(null)
    mockFetch.mockResolvedValue(new Response(JSON.stringify(ENDPOINT), { status: 201 }))
    globalThis.fetch = mockFetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('mints an endpoint (org JWT mode → ::memberId bearer) and parses the response', async () => {
    mockDecodeOrgIdFromToken.mockReturnValue('org_1')

    const endpoint = await createPlatformWebhookEndpoint('sub_member_1', {
      name: 'test endpoint',
      verification: {
        algorithm: 'hmac-sha256',
        encoding: 'hex',
        header: 'x-sig',
        template: '{body}',
        secret: 's3cret',
      },
    })

    expect(endpoint.url).toBe(ENDPOINT.url)
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toBe('https://proxy.test/v1/webhook-endpoints')
    expect((init as RequestInit).method).toBe('POST')
    const headers = (init as RequestInit).headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer token-value::sub_member_1')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.verification.secret).toBe('s3cret')
  })

  it('uses a plain bearer in opaque key mode', async () => {
    mockDecodeOrgIdFromToken.mockReturnValue(null)
    await createPlatformWebhookEndpoint('sub_member_1', { name: 'n' })
    const headers = (mockFetch.mock.calls[0][1] as RequestInit).headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer token-value')
  })

  it('PATCHes verification onto an existing endpoint', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(ENDPOINT), { status: 200 }))
    await updatePlatformWebhookEndpoint('sub_member_1', ENDPOINT.id, {
      verification: null,
    })
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toBe(`https://proxy.test/v1/webhook-endpoints/${ENDPOINT.id}`)
    expect((init as RequestInit).method).toBe('PATCH')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ verification: null })
  })

  it('disables via DELETE (status flip on the proxy)', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify(ENDPOINT), { status: 200 }))
    await disablePlatformWebhookEndpoint('sub_member_1', ENDPOINT.id)
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toBe(`https://proxy.test/v1/webhook-endpoints/${ENDPOINT.id}`)
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('lists endpoints', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ endpoints: [ENDPOINT] }), { status: 200 }),
    )
    const endpoints = await listPlatformWebhookEndpoints('sub_member_1')
    expect(endpoints).toHaveLength(1)
    expect(endpoints[0].id).toBe(ENDPOINT.id)
  })

  it('sends filter_exp on mint and PATCH (null clears)', async () => {
    await createPlatformWebhookEndpoint('sub_member_1', {
      name: 'n',
      filter_exp: 'body.action == "update"',
    })
    expect(JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string).filter_exp).toBe(
      'body.action == "update"',
    )

    mockFetch.mockResolvedValue(new Response(JSON.stringify(ENDPOINT), { status: 200 }))
    await updatePlatformWebhookEndpoint('sub_member_1', ENDPOINT.id, { filter_exp: null })
    expect(
      JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string),
    ).toEqual({ filter_exp: null })
  })

  it('lists recent events (filtered included) and surfaces the active filter', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          endpoint_id: ENDPOINT.id,
          filter_exp: 'verified',
          events: [
            {
              id: 'whe_1',
              created_at: '2026-07-07T20:45:19Z',
              status: 'filtered',
              kind: 'event',
              verified: true,
              filter: { outcome: 'filtered' },
              method: 'POST',
              content_type: 'application/json',
              headers: { 'linear-event': 'Issue' },
              query: {},
              body: '{"action":"create"}',
              body_truncated: false,
              body_encoding: 'utf8',
            },
          ],
        }),
        { status: 200 },
      ),
    )
    const { filterExp, events } = await listPlatformWebhookEvents('sub_member_1', ENDPOINT.id, 5)
    expect(filterExp).toBe('verified')
    expect(events).toHaveLength(1)
    expect(events[0].filter?.outcome).toBe('filtered')
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toBe(`https://proxy.test/v1/webhook-endpoints/${ENDPOINT.id}/events?limit=5`)
    expect((init as RequestInit).method).toBe('GET')
  })

  it('dry-runs a candidate filter via test-filter', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          endpoint_id: ENDPOINT.id,
          filter_exp: 'body.action == "update"',
          evaluated: 2,
          summary: { passed: 1, filtered: 1, error: 0, skipped: 0 },
          results: [
            { event_id: 'whe_1', created_at: '2026-07-07T20:45:19Z', stored_status: 'consumed', outcome: 'passed' },
            { event_id: 'whe_2', created_at: '2026-07-07T20:44:00Z', stored_status: 'filtered', outcome: 'filtered' },
          ],
        }),
        { status: 200 },
      ),
    )
    const result = await testPlatformWebhookFilter('sub_member_1', ENDPOINT.id, 'body.action == "update"')
    expect(result.summary.passed).toBe(1)
    expect(result.results[1].outcome).toBe('filtered')
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toBe(`https://proxy.test/v1/webhook-endpoints/${ENDPOINT.id}/test-filter`)
    expect((init as RequestInit).method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      filter_exp: 'body.action == "update"',
    })
  })

  it('propagates the proxy 400 (with the CEL parser message) on an invalid dry-run expression', async () => {
    mockFetch.mockResolvedValue(
      new Response('{"message":"Invalid filter expression: invalid CEL expression: Unexpected token: EOF"}', {
        status: 400,
      }),
    )
    await expect(
      testPlatformWebhookFilter('sub_member_1', ENDPOINT.id, 'body.action =='),
    ).rejects.toThrow(/400.*Unexpected token/)
  })

  it('throws on non-OK responses with the status and body', async () => {
    mockFetch.mockResolvedValue(new Response('quota exceeded', { status: 409 }))
    await expect(createPlatformWebhookEndpoint('sub_member_1', { name: 'n' })).rejects.toThrow(
      /409.*quota exceeded/,
    )
  })

  it('masks a secret echoed in an error body before throwing', async () => {
    // The thrown message flows into Sentry and the agent transcript — if the
    // proxy ever echoes the submitted request in an error, the signing secret
    // must not survive the trip.
    mockFetch.mockResolvedValue(
      new Response('{"error":"bad profile","request":{"verification":{"secret":"whsec_leaky_value"}}}', {
        status: 400,
      }),
    )
    const err = await createPlatformWebhookEndpoint('sub_member_1', { name: 'n' }).then(
      () => {
        throw new Error('expected rejection')
      },
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('"secret":"***"')
    expect((err as Error).message).not.toContain('whsec_leaky_value')
  })

  it('treats a bodyless 204 as success', async () => {
    // The proxy responds 200+row today, but a 204 must not read as a disable
    // failure — callers alarm on throw as "endpoint still live".
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(disablePlatformWebhookEndpoint('sub_member_1', ENDPOINT.id)).resolves.toBeUndefined()
  })

  it('rejects a malformed proxy response at the Zod boundary', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ nope: true }), { status: 201 }))
    await expect(createPlatformWebhookEndpoint('sub_member_1', { name: 'n' })).rejects.toThrow()
  })

  it('rolls back the live endpoint when the mint response carries an id but fails to parse', async () => {
    // Mint succeeded server-side (has an id) but the rest of the row is
    // malformed. Parsing throws inside the client, so the caller can never see
    // an endpoint to roll back — the client must issue the disable itself using
    // the raw id, or a live public URL is orphaned with no local trigger row.
    const orphanId = 'whep_99999999-8888-4777-8666-555555555555'
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      // POST mint: valid id, everything else wrong shape
      return Promise.resolve(new Response(JSON.stringify({ id: orphanId, bogus: 1 }), { status: 201 }))
    })

    await expect(createPlatformWebhookEndpoint('sub_member_1', { name: 'n' })).rejects.toThrow(
      /unexpected webhook-endpoint response/,
    )

    const deleteCall = mockFetch.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    )
    expect(deleteCall).toBeDefined()
    expect(deleteCall?.[0]).toContain(encodeURIComponent(orphanId))
  })
})
