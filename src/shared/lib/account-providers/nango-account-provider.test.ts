/**
 * The Nango secret key is read from settings on every use: another process
 * may save, change or remove it, and nothing tells this one. A provider built
 * once must therefore follow the stored key, not the one it was built with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ nangoKey: undefined as string | undefined, preferred: 'nango' as 'nango' | 'composio' }))
vi.mock('@shared/lib/config/settings', () => ({
  getNangoSecretKey: async () => state.nangoKey,
  getDefaultAccountProviderType: async () => state.preferred,
}))
vi.mock('@shared/lib/composio/client', () => ({}))

import { NangoAccountProvider } from './nango-account-provider'
import { registerAllAccountProviders } from './register'
import { getAccountProvider, getDefaultAccountProvider, getRegisteredProviders } from './provider-factory'

const fetchMock = vi.fn<typeof fetch>()

function connection(accessToken: string): Response {
  return Response.json({ provider_config_key: 'github', credentials: { type: 'OAUTH2', access_token: accessToken } })
}

function bearers(): string[] {
  return fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('Authorization') ?? '')
}

beforeEach(() => {
  state.nangoKey = 'nango-key-1'
  state.preferred = 'nango'
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('NangoAccountProvider', () => {
  it('signs each request with the key stored now', async () => {
    fetchMock.mockImplementation(async () => Response.json({ connections: [] }))
    const provider = new NangoAccountProvider()

    await provider.listConnections()
    state.nangoKey = 'nango-key-2'
    await provider.listConnections()

    expect(bearers()).toEqual(['Bearer nango-key-1', 'Bearer nango-key-2'])
  })

  it('refuses to call Nango once the key is removed, and says it is not configured', async () => {
    const provider = new NangoAccountProvider()
    expect(await provider.isConfigured()).toBe(true)

    state.nangoKey = undefined

    expect(await provider.isConfigured()).toBe(false)
    await expect(provider.listConnections()).rejects.toThrow(/not configured/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not hand out a connection token fetched under a previous key', async () => {
    fetchMock.mockImplementationOnce(async () => connection('token-from-account-1'))
    fetchMock.mockImplementation(async (url) => String(url).startsWith('https://api.nango.dev')
      ? connection('token-from-account-2')
      : new Response('ok'))
    const provider = new NangoAccountProvider()
    const call = { providerConnectionId: 'conn', toolkitSlug: 'github', targetUrl: 'https://api.github.com/user', method: 'GET', headers: new Headers(), body: null }

    await provider.makeApiCall(call)
    state.nangoKey = 'nango-key-2'
    await provider.makeApiCall(call)

    const upstream = bearers().filter((_, index) => !String(fetchMock.mock.calls[index][0]).startsWith('https://api.nango.dev'))
    expect(upstream).toEqual(['Bearer token-from-account-1', 'Bearer token-from-account-2'])
  })
})

describe('account provider registration', () => {
  it('follows the stored key without re-registering', async () => {
    registerAllAccountProviders()
    const nango = getAccountProvider('nango')

    expect((await getDefaultAccountProvider()).name).toBe('nango')
    expect((await getRegisteredProviders()).map((provider) => provider.name)).toEqual(['composio', 'nango'])

    state.nangoKey = undefined

    // The same registered provider, now unconfigured: not the default, not synced.
    expect(getAccountProvider('nango')).toBe(nango)
    expect((await getDefaultAccountProvider()).name).toBe('composio')
    expect((await getRegisteredProviders()).map((provider) => provider.name)).toEqual(['composio'])

    state.nangoKey = 'nango-key-3'
    expect((await getDefaultAccountProvider()).name).toBe('nango')
  })
})
