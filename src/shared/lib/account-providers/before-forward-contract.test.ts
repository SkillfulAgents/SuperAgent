import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The makeApiCall contract: `beforeForward` is awaited AFTER all
// provider-internal credential/mode resolution and IMMEDIATELY before the
// outbound request; throwing aborts the forward. The proxy route relies on
// this to revalidate an autopilot approval at the last moment before the
// side effect executes — a provider that skips the guard, or runs it before
// its own awaits, reopens the revocation window.

vi.mock('./service-catalog', () => ({
  getProviderSlug: vi.fn(() => 'google-mail'),
  getToolkitSlugFromProviderSlug: vi.fn(() => 'gmail'),
}))

const { FakeRedactedTokenError, mockGetConnectionToken, mockProxyExecute } = vi.hoisted(() => {
  class FakeRedactedTokenError extends Error {}
  return { FakeRedactedTokenError, mockGetConnectionToken: vi.fn(), mockProxyExecute: vi.fn() }
})
vi.mock('@shared/lib/composio/client', () => ({
  getOrCreateAuthConfig: vi.fn(),
  initiateConnection: vi.fn(),
  getConnection: vi.fn(),
  deleteConnection: vi.fn(),
  listConnections: vi.fn(),
  getConnectionToken: (...args: unknown[]) => mockGetConnectionToken(...args),
  proxyExecute: (...args: unknown[]) => mockProxyExecute(...args),
  ComposioRedactedTokenError: FakeRedactedTokenError,
}))

import { NangoAccountProvider } from './nango-account-provider'
import { ComposioAccountProvider } from './composio-account-provider'

const fetchMock = vi.fn()

function baseParams(beforeForward: () => Promise<void>) {
  return {
    providerConnectionId: 'conn-1',
    toolkitSlug: 'gmail',
    targetUrl: 'https://gmail.googleapis.com/gmail/v1/messages/send',
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    body: new TextEncoder().encode('{"to":"a@b.c"}').buffer as ArrayBuffer,
    beforeForward,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('NangoAccountProvider.makeApiCall', () => {
  const tokenJson = {
    provider_config_key: 'google-mail',
    credentials: { type: 'OAUTH2', access_token: 'nango-tok' },
  }

  it('awaits beforeForward after token resolution and before the outbound fetch', async () => {
    const order: string[] = []
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith('https://api.nango.dev')) {
        order.push('token')
        return new Response(JSON.stringify(tokenJson), { status: 200 })
      }
      order.push('outbound')
      return new Response('{}', { status: 200 })
    })

    const provider = new NangoAccountProvider({ secretKey: 'sk' })
    await provider.makeApiCall(
      baseParams(async () => {
        order.push('guard')
      })
    )
    expect(order).toEqual(['token', 'guard', 'outbound'])
  })

  it('a throwing guard aborts the forward — no outbound request is issued', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).startsWith('https://api.nango.dev')) {
        return new Response(JSON.stringify(tokenJson), { status: 200 })
      }
      throw new Error('outbound fetch must not happen')
    })

    const provider = new NangoAccountProvider({ secretKey: 'sk' })
    await expect(
      provider.makeApiCall(
        baseParams(async () => {
          throw new Error('revoked')
        })
      )
    ).rejects.toThrow('revoked')
    const outboundCalls = fetchMock.mock.calls.filter(
      (c) => !String(c[0]).startsWith('https://api.nango.dev')
    )
    expect(outboundCalls).toHaveLength(0)
  })
})

describe('ComposioAccountProvider.makeApiCall', () => {
  it('direct-forward mode: guard runs after credential resolution, before the fetch; throwing aborts', async () => {
    const order: string[] = []
    mockGetConnectionToken.mockImplementation(async () => {
      order.push('token')
      return { accessToken: 'tok', expiresAt: undefined }
    })
    fetchMock.mockImplementation(async () => {
      order.push('outbound')
      return new Response('{}', { status: 200 })
    })

    const provider = new ComposioAccountProvider()
    await provider.makeApiCall(
      baseParams(async () => {
        order.push('guard')
      })
    )
    expect(order).toEqual(['token', 'guard', 'outbound'])

    await expect(
      provider.makeApiCall(
        baseParams(async () => {
          throw new Error('revoked')
        })
      )
    ).rejects.toThrow('revoked')
    // Only the first call's outbound fetch happened.
    expect(order.filter((s) => s === 'outbound')).toHaveLength(1)
  })

  it('proxy mode: guard runs immediately before proxyExecute; throwing aborts', async () => {
    mockGetConnectionToken.mockRejectedValue(new FakeRedactedTokenError('redacted'))
    mockProxyExecute.mockResolvedValue({ status: 200, headers: {}, body: '{}' })

    const provider = new ComposioAccountProvider()
    await expect(
      provider.makeApiCall(
        baseParams(async () => {
          throw new Error('revoked')
        })
      )
    ).rejects.toThrow('revoked')
    expect(mockProxyExecute).not.toHaveBeenCalled()
  })
})
