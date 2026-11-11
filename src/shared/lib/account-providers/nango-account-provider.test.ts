/**
 * The Nango secret key is read from settings on every use: another process
 * may save, change or remove it, and nothing tells this one. A provider built
 * once must therefore follow the stored key, not the one it was built with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ nangoKey: undefined as string | undefined, preferred: 'nango' as 'nango' | 'composio', keyReads: 0 }))
vi.mock('@shared/lib/config/settings', () => ({
  getNangoSecretKey: async () => {
    state.keyReads++
    return state.nangoKey
  },
  // From settings a caller already read (here, the stored key).
  nangoSecretKeyFrom: () => state.nangoKey,
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
  state.keyReads = 0
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

describe('NangoAccountProvider token fetches', () => {
  it('shares one token fetch between calls that miss the cache together', async () => {
    fetchMock.mockImplementation(async (url) => String(url).startsWith('https://api.nango.dev')
      ? connection('token-1')
      : new Response('ok'))
    const provider = new NangoAccountProvider()
    const call = { providerConnectionId: 'conn', toolkitSlug: 'github', targetUrl: 'https://api.github.com/user', method: 'GET', headers: new Headers(), body: null }

    await Promise.all([provider.makeApiCall(call), provider.makeApiCall(call), provider.makeApiCall(call)])

    const tokenFetches = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://api.nango.dev/connections/conn?'))
    expect(tokenFetches).toHaveLength(1)
    const upstream = bearers().filter((_, index) => String(fetchMock.mock.calls[index][0]).startsWith('https://api.github.com'))
    expect(upstream).toEqual(['Bearer token-1', 'Bearer token-1', 'Bearer token-1'])
  })

  it('fetches again after a shared fetch fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('down', { status: 500 }))
    fetchMock.mockImplementation(async (url) => String(url).startsWith('https://api.nango.dev')
      ? connection('token-2')
      : new Response('ok'))
    const provider = new NangoAccountProvider()
    const call = { providerConnectionId: 'conn', toolkitSlug: 'github', targetUrl: 'https://api.github.com/user', method: 'GET', headers: new Headers(), body: null }

    await expect(provider.makeApiCall(call)).rejects.toThrow()
    expect((await provider.makeApiCall(call)).status).toBe(200)
  })
})

describe('NangoAccountProvider across a key change', () => {
  it('never caches a token fetched under the previous key once the new key was seen', async () => {
    const isTokenFetch = (url: unknown) => String(url).startsWith('https://api.nango.dev/connections/conn?')
    let landOldTokenFetch!: () => void
    fetchMock.mockImplementation(async (url, init) => {
      const bearer = new Headers(init?.headers).get('Authorization')
      if (isTokenFetch(url) && bearer === 'Bearer nango-key-1') {
        // The fetch made under the old key is slow to answer.
        await new Promise<void>((resolve) => { landOldTokenFetch = resolve })
        return connection('token-from-account-1')
      }
      if (isTokenFetch(url)) return connection('token-from-account-2')
      if (String(url).startsWith('https://api.nango.dev')) return Response.json({ connections: [] })
      return new Response('ok')
    })
    const provider = new NangoAccountProvider()
    const call = { providerConnectionId: 'conn', toolkitSlug: 'github', targetUrl: 'https://api.github.com/user', method: 'GET', headers: new Headers(), body: null }

    // A request under key 1 is fetching its token when another process saves key 2…
    const first = provider.makeApiCall(call)
    await vi.waitFor(() => expect(landOldTokenFetch).toBeTypeOf('function'))
    state.nangoKey = 'nango-key-2'
    // …and this one sees key 2 first.
    await provider.listConnections()
    landOldTokenFetch()
    await first

    await provider.makeApiCall(call)

    const upstream = bearers().filter((_, index) => String(fetchMock.mock.calls[index][0]).startsWith('https://api.github.com'))
    expect(upstream.at(-1)).toBe('Bearer token-from-account-2')
  })
})

describe('secret key reads for one proxied request', () => {
  const call = { providerConnectionId: 'conn', toolkitSlug: 'github', targetUrl: 'https://api.github.com/user', method: 'GET', headers: new Headers(), body: null }
  const respond = () => fetchMock.mockImplementation(async (url) => String(url).startsWith('https://api.nango.dev')
    ? connection('token-1')
    : new Response('ok'))

  it('reads the key once for a token lookup and its fetch', async () => {
    respond()
    await new NangoAccountProvider().makeApiCall(call)
    expect(state.keyReads).toBe(1)
  })

  it('reads nothing for the status check and the forward when the request took the key', async () => {
    respond()
    const provider = new NangoAccountProvider()
    const credentials = provider.credentialsFrom({})
    await provider.getConnection('conn', 'github', credentials)
    await provider.makeApiCall({ ...call, credentials })
    expect(state.keyReads).toBe(0)
    expect(bearers().filter((_, i) => String(fetchMock.mock.calls[i][0]).startsWith('https://api.nango.dev')))
      .toEqual(['Bearer nango-key-1', 'Bearer nango-key-1'])
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
