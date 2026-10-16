import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const { token, proxy } = vi.hoisted(() => ({ token: vi.fn(), proxy: vi.fn() }))
vi.mock('@shared/lib/composio/client', () => ({
  getConnectionToken: token, proxyExecute: proxy,
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
      })
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
    }))
    expect(proxy.mock.calls[0][0].binaryBody).toBeUndefined()
  })

  it('retains the explicit content type for empty uploads and session commits without binary_body', async () => {
    await new ComposioAccountProvider().makeApiCall({ ...base,
      headers: new Headers({ 'Content-Type': 'application/octet-stream' }), body: new ArrayBuffer(0),
    })
    expect(proxy).toHaveBeenCalledWith(expect.objectContaining({
      parameters: [{ name: 'content-type', value: 'application/octet-stream', type: 'header' }],
    }))
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
