import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getConnectionToken: vi.fn(),
  proxyExecute: vi.fn(),
  isPlatformComposioActive: vi.fn(),
}))

vi.mock('@shared/lib/composio/client', () => ({
  getOrCreateAuthConfig: vi.fn(),
  initiateConnection: vi.fn(),
  getConnection: vi.fn(),
  deleteConnection: vi.fn(),
  listConnections: vi.fn(),
  getConnectionToken: mocks.getConnectionToken,
  proxyExecute: mocks.proxyExecute,
  isPlatformComposioActive: mocks.isPlatformComposioActive,
  ComposioApiError: class extends Error {
    constructor(message: string, public statusCode: number, public details?: unknown) {
      super(message)
    }
  },
  ComposioRedactedTokenError: class extends Error {},
}))

import { ComposioAccountProvider } from './composio-account-provider'
import { ComposioApiError, ComposioRedactedTokenError } from '@shared/lib/composio/client'

const call = (toolkitSlug: string) => ({
  providerConnectionId: 'ca_1',
  toolkitSlug,
  targetUrl: 'https://gmail.googleapis.com/gmail/v1/messages',
  method: 'GET',
  headers: new Headers(),
  body: null,
})

describe('ComposioAccountProvider on the platform hop', () => {
  let provider: ComposioAccountProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new ComposioAccountProvider()
    mocks.isPlatformComposioActive.mockReturnValue(true)
    mocks.proxyExecute.mockResolvedValue({ status: 200, headers: {}, data: {} })
    // The platform redacts the token on its shared key, so the probe lands in proxy mode.
    mocks.getConnectionToken.mockRejectedValue(new ComposioRedactedTokenError('Access token is redacted by Composio'))
  })

  it('takes the hop when the platform redacts the token', async () => {
    const res = await provider.makeApiCall(call('gmail'))
    expect(res.status).toBe(200)
    expect(mocks.proxyExecute).toHaveBeenCalledTimes(1)
  })

  it('calls the vendor directly when Composio returns a real token', async () => {
    mocks.getConnectionToken.mockResolvedValue({ accessToken: 'tok', expiresAt: null })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    const res = await provider.makeApiCall(call('gmail'))
    expect(res.status).toBe(204)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/messages')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok')
    expect(mocks.proxyExecute).not.toHaveBeenCalled()
  })

  it('returns a hop refusal to the agent with the platform status and body', async () => {
    // The hop answers with a bare { message } body, parsed untyped by composioFetch.
    const body = JSON.parse('{"message":"Payload too large"}')
    mocks.proxyExecute.mockRejectedValue(new ComposioApiError('Payload too large', 413, body))
    const res = await provider.makeApiCall(call('gmail'))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ message: 'Payload too large' })
  })

  it('keeps other hop failures as thrown errors', async () => {
    mocks.proxyExecute.mockRejectedValue(new ComposioApiError('upstream down', 502))
    await expect(provider.makeApiCall(call('gmail'))).rejects.toThrow('upstream down')
  })

  it('keeps a refusal status as a thrown error on a local Composio key', async () => {
    mocks.isPlatformComposioActive.mockReturnValue(false)
    mocks.proxyExecute.mockRejectedValue(new ComposioApiError('Not found', 404))
    await expect(provider.makeApiCall(call('gmail'))).rejects.toThrow('Not found')
  })
})
