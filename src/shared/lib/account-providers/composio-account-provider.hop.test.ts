import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Drives the real Composio client, response schema, and provider with only
// the network stubbed, so a broken error parse or envelope conversion shows
// up here and not in production.
vi.mock('@shared/lib/config/settings', () => ({
  getEffectiveComposioApiKey: () => undefined,
  getComposioUserId: () => 'user_1',
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => 'platform-token',
}))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://platform.test',
}))
vi.mock('@shared/lib/error-reporting', () => ({ addErrorBreadcrumb: vi.fn() }))

import { ComposioAccountProvider } from './composio-account-provider'

const call = {
  providerConnectionId: 'ca_1',
  toolkitSlug: 'gmail',
  targetUrl: 'https://gmail.googleapis.com/gmail/v1/messages',
  method: 'GET',
  headers: new Headers(),
  body: null,
}

describe('ComposioAccountProvider through the real client', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    // Composio redacts managed-config tokens, which lands the connection in
    // proxy mode through the existing probe.
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ id: 'ca_1', toolkit: { slug: 'gmail' }, state: { authScheme: 'OAUTH2', val: { access_token: 'REDACTED' } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('sends the call to the platform hop and keeps the inner status from the envelope', async () => {
    // Outer 200 from the hop, inner 401 from the vendor: the route relies on seeing the 401.
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ status: 401, data: { error: 'Invalid Credentials' }, headers: { 'content-type': 'application/json' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const res = await new ComposioAccountProvider().makeApiCall(call)
    expect(fetchMock.mock.calls[0][0]).toContain('/connected_accounts/ca_1')
    expect(fetchMock.mock.calls[1][0]).toBe('https://platform.test/v1/composio/tools/execute/proxy')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid Credentials' })
  })

  it('returns a hop refusal with the platform body intact', async () => {
    // The platform's balance refusal, as its jsonError helper shapes it.
    const refusal = {
      type: 'error',
      error: { type: 'insufficient_balance', message: 'Add credits to continue', subscription_required: true },
    }
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify(refusal),
      { status: 402, headers: { 'Content-Type': 'application/json' } },
    ))
    const res = await new ComposioAccountProvider().makeApiCall(call)
    expect(res.status).toBe(402)
    expect(await res.json()).toEqual(refusal)
  })
})
