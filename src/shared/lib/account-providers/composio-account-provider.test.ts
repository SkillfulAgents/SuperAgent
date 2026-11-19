import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const { token, proxy, resolveAuth, AUTH } = vi.hoisted(() => ({
  token: vi.fn(), proxy: vi.fn(), resolveAuth: vi.fn(),
  /** What a settings read resolves the Composio credentials to. */
  AUTH: { localApiKey: 'local-key', platformToken: null, userId: 'user' },
}))
vi.mock('@shared/lib/composio/client', () => ({
  getConnectionToken: token, proxyExecute: proxy,
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

  it('sends a Drive upload session PUT straight to the link without credentials when the token is hidden', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"id":"f"}', { status: 200, headers: { 'Content-Encoding': 'gzip' } }))
    vi.stubGlobal('fetch', fetch)
    const link = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc'
    const bytes = new Uint8Array(1024 * 1024).buffer
    const call = { ...base, toolkitSlug: 'googledrive', method: 'PUT', body: bytes,
      headers: new Headers({ Authorization: 'Bearer agent-proxy-token', Cookie: 'a=b', Expect: '100-continue', 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-1048575/1048576' }) }
    const response = await new ComposioAccountProvider().makeApiCall({ ...call, targetUrl: link })
    expect(proxy).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith(link, expect.objectContaining({ body: bytes, redirect: 'manual' }))
    expect(fetch.mock.calls[0][1]!.headers).toEqual(new Headers({ 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-1048575/1048576' }))
    expect(response.headers.has('content-encoding')).toBe(false)
  })

  it.each([
    ['no upload_id', { targetUrl: 'https://www.googleapis.com/upload/drive/v3/files/x?uploadType=media' }],
    ['an empty upload_id', { targetUrl: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=' }],
    ['a POST', { method: 'POST' }],
    ['a path outside Drive uploads', { targetUrl: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc' }],
    ['another host', { targetUrl: 'https://drive.example.com/upload/drive/v3/files?upload_id=abc' }],
    ['another toolkit', { toolkitSlug: 'gmail' }],
  ])('keeps a hidden-token request with %s on the Composio proxy', async (_case, change) => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>())
    await new ComposioAccountProvider().makeApiCall({ ...base, toolkitSlug: 'googledrive', method: 'PUT',
      targetUrl: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc',
      headers: new Headers({ 'Content-Type': 'application/octet-stream' }), body: new Uint8Array(4).buffer, ...change })
    expect(proxy).toHaveBeenCalledOnce()
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

  it('keeps the token, cookies and redirects on a Drive upload session when the token is available', async () => {
    token.mockResolvedValue({ accessToken: 'test-token' })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 308 }))
    vi.stubGlobal('fetch', fetch)
    await new ComposioAccountProvider().makeApiCall({ ...base, toolkitSlug: 'googledrive', method: 'PUT',
      targetUrl: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc',
      headers: new Headers({ Cookie: 'a=b' }), body: new Uint8Array(4).buffer })
    expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'follow' })
    expect(fetch.mock.calls[0][1]!.headers).toEqual(new Headers({ Cookie: 'a=b', Authorization: 'Bearer test-token' }))
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

describe('Composio token reads', () => {
  const call = { ...base, method: 'GET', headers: new Headers(), body: null }

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

  it('fetches again after a shared fetch fails', async () => {
    token.mockRejectedValueOnce(new Error('No access token: the connected account is EXPIRED'))
    token.mockResolvedValue({ accessToken: 'token-after-reconnect' })
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    const provider = new ComposioAccountProvider()

    await expect(provider.makeApiCall(call)).rejects.toThrow('EXPIRED')
    expect(fetch).not.toHaveBeenCalled()
    expect((await provider.makeApiCall(call)).status).toBe(200)
    expect(token).toHaveBeenCalledTimes(2)
  })
})
