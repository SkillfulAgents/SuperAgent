import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const { token, withToken, proxy, resolveAuth, AUTH } = vi.hoisted(() => ({
  token: vi.fn(), withToken: vi.fn(), proxy: vi.fn(), resolveAuth: vi.fn(),
  /** What a settings read resolves the Composio credentials to. */
  AUTH: { localApiKey: 'local-key', platformToken: null, userId: 'user' },
}))
vi.mock('@shared/lib/composio/client', () => ({
  getConnectionToken: token, getConnectionWithToken: withToken, proxyExecute: proxy,
  resolveComposioAuth: resolveAuth,
  composioAuthFrom: () => ({ localApiKey: 'from-settings', platformToken: null, userId: null }),
  ComposioRedactedTokenError: class extends Error {},
}))
import { ComposioRedactedTokenError } from '@shared/lib/composio/client'
import { ComposioAccountProvider } from './composio-account-provider'

const base = {
  providerConnectionId: 'connection', toolkitSlug: 'dropbox',
  targetUrl: 'https://content.dropboxapi.com/2/files/upload', method: 'POST',
}

beforeEach(() => {
  vi.resetAllMocks()
  token.mockRejectedValue(new ComposioRedactedTokenError('Token is managed by Composio'))
  proxy.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} })
  resolveAuth.mockResolvedValue(AUTH)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('Composio binary transport', () => {
  it.each(['application/octet-stream', 'image/png'])('lets binary_body supply the only upstream Content-Type for %s', async contentType => {
    const provider = new ComposioAccountProvider()
    const bytes = new Uint8Array([0, 255, 128, 10]).buffer
    const headers = new Headers({ 'Content-Type': contentType, 'Dropbox-API-Arg': '{"path":"/test.bin","mode":"add"}' })
    for (let i = 0; i < 2; i++) {
      expect((await provider.makeApiCall({ ...base, headers, body: bytes })).status).toBe(200)
      expect(proxy).toHaveBeenLastCalledWith({
        endpoint: base.targetUrl, method: 'POST', connectedAccountId: 'connection',
        parameters: [{ name: 'dropbox-api-arg', value: headers.get('Dropbox-API-Arg'), type: 'header' }],
        binaryBody: { base64: Buffer.from(bytes).toString('base64'), content_type: contentType },
      }, AUTH)
    }
    // A retry must see the original headers and take the same binary path.
    expect(headers.get('Content-Type')).toBe(contentType)
    expect(token).toHaveBeenCalledOnce()
  })

  it('preserves explicit JSON headers and object bodies on RPC requests', async () => {
    await new ComposioAccountProvider().makeApiCall({ ...base,
      headers: new Headers({ 'Content-Type': 'application/json' }), body: new TextEncoder().encode('{"path":"/Team"}').buffer,
    })
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      body: { path: '/Team' }, parameters: [{ name: 'content-type', value: 'application/json', type: 'header' }],
    }), AUTH)
    expect(proxy.mock.calls[0][0].binaryBody).toBeUndefined()
  })

  it('retains the explicit content type for empty uploads and session commits without binary_body', async () => {
    await new ComposioAccountProvider().makeApiCall({ ...base,
      headers: new Headers({ 'Content-Type': 'application/octet-stream' }), body: new ArrayBuffer(0),
    })
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      parameters: [{ name: 'content-type', value: 'application/octet-stream', type: 'header' }],
    }), AUTH)
    expect(proxy.mock.calls[0][0].binaryBody).toBeUndefined()
  })

  it('keeps Content-Type and raw bytes on the direct-token transport', async () => {
    token.mockResolvedValue({ accessToken: 'test-token' })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    const bytes = new Uint8Array([0, 255, 128]).buffer
    await new ComposioAccountProvider().makeApiCall({ ...base, headers: new Headers({ 'Content-Type': 'application/octet-stream' }), body: bytes })
    expect(proxy).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith(base.targetUrl, expect.objectContaining({ body: bytes }))
    expect(fetch.mock.calls[0][1]!.headers).toEqual(new Headers({
      'Content-Type': 'application/octet-stream', Authorization: 'Bearer test-token',
    }))
  })
})

describe('Composio credentials for one proxied request', () => {
  it('reads the credentials once for the token lookup and the forward', async () => {
    await new ComposioAccountProvider().makeApiCall({ ...base, headers: new Headers(), body: null })
    expect(resolveAuth).toHaveBeenCalledOnce()
    expect(token).toHaveBeenCalledWith('connection', AUTH)
    expect(proxy).toHaveBeenCalledWith(expect.anything(), AUTH)
  })

  it('reads nothing when the token it cached goes straight to the upstream', async () => {
    token.mockResolvedValue({ accessToken: 'test-token' })
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok')))
    const provider = new ComposioAccountProvider()
    await provider.makeApiCall({ ...base, headers: new Headers(), body: null })
    resolveAuth.mockClear()
    await provider.makeApiCall({ ...base, headers: new Headers(), body: null })
    expect(resolveAuth).not.toHaveBeenCalled()
  })

  it('uses the credentials the request took instead of reading settings', async () => {
    const provider = new ComposioAccountProvider()
    const credentials = provider.credentialsFrom({})
    await provider.getConnection('connection', 'dropbox', credentials).catch(() => undefined)
    await provider.makeApiCall({ ...base, headers: new Headers(), body: null, credentials })
    expect(resolveAuth).not.toHaveBeenCalled()
    const taken = { localApiKey: 'from-settings', platformToken: null, userId: null }
    expect(token).toHaveBeenCalledWith('connection', taken)
    expect(proxy).toHaveBeenCalledWith(expect.anything(), taken)
  })
})

describe('Composio account reads', () => {
  const call = { ...base, method: 'GET', headers: new Headers(), body: null }

  it('reuses the token from the status check, so a cold cache fetches the account once', async () => {
    withToken.mockResolvedValue({ connection: { id: 'connection', status: 'ACTIVE' }, token: () => ({ accessToken: 'status-token' }) })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    const provider = new ComposioAccountProvider()

    expect((await provider.getConnection('connection')).status).toBe('ACTIVE')
    await provider.makeApiCall(call)

    expect(withToken).toHaveBeenCalledOnce()
    expect(token).not.toHaveBeenCalled()
    expect(new Headers(fetch.mock.calls[0][1]!.headers).get('Authorization')).toBe('Bearer status-token')
  })

  it('leaves the token to the call when the account is not active', async () => {
    withToken.mockResolvedValue({ connection: { id: 'connection', status: 'EXPIRED' }, token: () => ({ accessToken: 'stale-token' }) })
    token.mockResolvedValue({ accessToken: 'fresh-token' })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    const provider = new ComposioAccountProvider()

    await provider.getConnection('connection')
    await provider.makeApiCall(call)

    expect(token).toHaveBeenCalledOnce()
    expect(new Headers(fetch.mock.calls[0][1]!.headers).get('Authorization')).toBe('Bearer fresh-token')
  })

  it('shares one token fetch between calls that miss the cache together', async () => {
    token.mockResolvedValue({ accessToken: 'shared-token' })
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('ok')))
    const provider = new ComposioAccountProvider()

    await Promise.all([provider.makeApiCall(call), provider.makeApiCall(call), provider.makeApiCall(call)])

    expect(token).toHaveBeenCalledOnce()
  })

  it('shares one redacted-token answer and uses the Composio proxy for all calls', async () => {
    const provider = new ComposioAccountProvider()

    await Promise.all([provider.makeApiCall(call), provider.makeApiCall(call)])

    expect(token).toHaveBeenCalledOnce()
    expect(proxy).toHaveBeenCalledTimes(2)
  })
})
