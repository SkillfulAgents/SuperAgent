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
import { ComposioApiError } from '@shared/lib/composio/client'

const call = (toolkitSlug: string) => ({
  providerConnectionId: 'ca_1',
  toolkitSlug,
  targetUrl: 'https://api.x.com/2/users/me',
  method: 'GET',
  headers: new Headers(),
  body: null,
})

describe('ComposioAccountProvider proxy-only toolkits', () => {
  let provider: ComposioAccountProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new ComposioAccountProvider()
    mocks.proxyExecute.mockResolvedValue({ status: 200, headers: {}, data: {} })
    mocks.getConnectionToken.mockResolvedValue({ accessToken: 'tok', expiresAt: null })
  })

  it('sends twitter through the hop without reading the token on platform Composio', async () => {
    mocks.isPlatformComposioActive.mockReturnValue(true)
    const res = await provider.makeApiCall(call('twitter'))
    expect(res.status).toBe(200)
    expect(mocks.getConnectionToken).not.toHaveBeenCalled()
    expect(mocks.proxyExecute).toHaveBeenCalledTimes(1)
  })

  it('resolves the connection mode for twitter on a local Composio key', async () => {
    mocks.isPlatformComposioActive.mockReturnValue(false)
    // Token mode would call X directly; stub fetch so the test stays offline.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    await provider.makeApiCall(call('twitter'))
    expect(mocks.getConnectionToken).toHaveBeenCalledTimes(1)
    expect(mocks.proxyExecute).not.toHaveBeenCalled()
  })

  it('returns a hop refusal to the agent with the platform status and body', async () => {
    mocks.isPlatformComposioActive.mockReturnValue(true)
    // The hop answers with a bare { message } body, parsed untyped by composioFetch.
    const body = JSON.parse('{"message":"Payload too large"}')
    mocks.proxyExecute.mockRejectedValue(new ComposioApiError('Payload too large', 413, body))
    const res = await provider.makeApiCall(call('twitter'))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ message: 'Payload too large' })
  })

  it('keeps other hop failures as thrown errors', async () => {
    mocks.isPlatformComposioActive.mockReturnValue(true)
    mocks.proxyExecute.mockRejectedValue(new ComposioApiError('upstream down', 502))
    await expect(provider.makeApiCall(call('twitter'))).rejects.toThrow('upstream down')
  })

  it('resolves the connection mode for other toolkits on platform Composio', async () => {
    mocks.isPlatformComposioActive.mockReturnValue(true)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    await provider.makeApiCall(call('gmail'))
    expect(mocks.getConnectionToken).toHaveBeenCalledTimes(1)
  })
})
