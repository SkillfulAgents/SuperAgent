import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getOrCreateAuthConfig: vi.fn(),
  listConnections: vi.fn(),
  getConnectionToken: vi.fn(),
  proxyExecute: vi.fn(),
  isPlatformComposioActive: vi.fn(),
}))

vi.mock('@shared/lib/composio/client', () => ({
  getOrCreateAuthConfig: mocks.getOrCreateAuthConfig,
  initiateConnection: vi.fn(async (authConfigId: string) => ({ connectionId: 'ca_1', redirectUrl: `https://x/${authConfigId}` })),
  getConnection: vi.fn(),
  deleteConnection: vi.fn(),
  listConnections: mocks.listConnections,
  getConnectionToken: mocks.getConnectionToken,
  proxyExecute: mocks.proxyExecute,
  isPlatformComposioActive: mocks.isPlatformComposioActive,
  ComposioRedactedTokenError: class extends Error {},
}))

import { ComposioAccountProvider } from './composio-account-provider'

const call = (toolkitSlug: string) => ({
  providerConnectionId: 'ca_1',
  toolkitSlug,
  targetUrl: 'https://api.x.com/2/users/me',
  method: 'GET',
  headers: new Headers(),
  body: null,
})

describe('ComposioAccountProvider slug mapping', () => {
  let provider: ComposioAccountProvider

  beforeEach(() => {
    vi.clearAllMocks()
    provider = new ComposioAccountProvider()
    mocks.getOrCreateAuthConfig.mockImplementation(async (slug: string) => ({ id: `ac_${slug}` }))
    mocks.listConnections.mockResolvedValue([
      { id: 'ca_plaid', status: 'ACTIVE', toolkitSlug: 'custom_plaid' },
      { id: 'ca_gmail', status: 'ACTIVE', toolkitSlug: 'gmail' },
      { id: 'ca_unknown', status: 'ACTIVE', toolkitSlug: 'some_new_toolkit' },
    ])
  })

  it('initiates with the Composio toolkit slug from the catalog', async () => {
    await provider.initiateConnection('plaid', 'https://cb')
    expect(mocks.getOrCreateAuthConfig).toHaveBeenCalledWith('custom_plaid')
    await provider.initiateConnection('gmail', 'https://cb')
    expect(mocks.getOrCreateAuthConfig).toHaveBeenCalledWith('gmail')
  })

  it('lists connections under the catalog slug, passing unknown toolkits through', async () => {
    const list = await provider.listConnections()
    expect(list.map((c) => [c.id, c.toolkitSlug])).toEqual([
      ['ca_plaid', 'plaid'],
      ['ca_gmail', 'gmail'],
      ['ca_unknown', 'some_new_toolkit'],
    ])
  })
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

  it('sends plaid through the hop without reading the token on platform Composio', async () => {
    mocks.isPlatformComposioActive.mockReturnValue(true)
    const res = await provider.makeApiCall({ ...call('plaid'), targetUrl: 'https://production.plaid.com/accounts/get', method: 'POST' })
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

  it('resolves the connection mode for other toolkits on platform Composio', async () => {
    mocks.isPlatformComposioActive.mockReturnValue(true)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    await provider.makeApiCall(call('gmail'))
    expect(mocks.getConnectionToken).toHaveBeenCalledTimes(1)
  })
})
