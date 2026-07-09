import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/lib/services/platform-auth-service', () => ({ getPlatformAccessToken: vi.fn() }))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: vi.fn(() => 'https://proxy.gamut.test'),
}))

import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { PlatformWebProvider } from './platform-web-provider'

const searchBody = { results: [{ url: 'https://a.com', title: 'A', highlights: ['hi'] }] }
const contentsBody = { results: [{ url: 'https://a.com', title: 'A', text: 'full page' }] }

describe('PlatformWebProvider', () => {
  const provider = new PlatformWebProvider()
  beforeEach(() => vi.restoreAllMocks())

  describe('search', () => {
    it('POSTs to the proxy search path with a Bearer token and the Exa body, mapping the response', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      const fetchMock = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify(searchBody), { status: 200 }))
      const res = await provider.search('cats', { numResults: 3 })
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://proxy.gamut.test/v1/exa/search')
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
      expect((init!.headers as Record<string, string>)['x-api-key']).toBeUndefined()
      expect(JSON.parse(init!.body as string)).toMatchObject({ query: 'cats', numResults: 3 })
      expect(res.hits[0]).toMatchObject({ url: 'https://a.com', title: 'A', snippet: 'hi' })
    })

    it('forwards the domain-restriction, date-range, and contents fields in the request body', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      const fetchMock = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify(searchBody), { status: 200 }))
      await provider.search('q', {
        numResults: 5,
        includeDomains: ['a.com'],
        excludeDomains: ['b.com'],
        startPublishedDate: '2024-01-01',
        endPublishedDate: '2024-12-31',
      })
      expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({
        query: 'q',
        numResults: 5,
        includeDomains: ['a.com'],
        excludeDomains: ['b.com'],
        startPublishedDate: '2024-01-01',
        endPublishedDate: '2024-12-31',
        contents: { highlights: true, text: { maxCharacters: 800 } },
      })
    })

    it('pre-guards with an actionable message when not signed in (no network call)', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue(null)
      const fetchMock = vi.spyOn(global, 'fetch')
      await expect(provider.search('x', {})).rejects.toThrow(/not signed into Gamut/i)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('maps a 402 to an actionable billing message', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('blocked', { status: 402 }))
      await expect(provider.search('x', {})).rejects.toThrow(/billing issue/i)
    })

    it.each([401, 403])('maps a %i (revoked/expired token) to a sign-in-again message', async (status) => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status }))
      await expect(provider.search('x', {})).rejects.toThrow(/session has expired or is invalid.*sign in again/i)
    })

    it('passes a non-mapped proxy error through unchanged (not the billing message)', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }))
      await expect(provider.search('x', {})).rejects.toThrow(/request failed: 404/i)
      await expect(provider.search('x', {})).rejects.not.toThrow(/billing/i)
    })
  })

  describe('fetch', () => {
    it('POSTs to the proxy contents path with Bearer + the Exa contents body', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      const fetchMock = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify(contentsBody), { status: 200 }))
      const res = await provider.fetch('https://a.com', {})
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://proxy.gamut.test/v1/exa/contents')
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
      expect(JSON.parse(init!.body as string)).toMatchObject({
        urls: ['https://a.com'],
        filterEmptyResults: false,
      })
      expect(res).toMatchObject({ url: 'https://a.com', title: 'A', content: 'full page' })
      expect(typeof res.fetchedAt).toBe('string')
    })

    it('bounds content length with text.maxCharacters when maxChars is given', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      const fetchMock = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify(contentsBody), { status: 200 }))
      await provider.fetch('https://a.com', { maxChars: 500 })
      expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).text).toEqual({ maxCharacters: 500 })
    })

    it('pre-guards when not signed in (no network call)', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue(null)
      const fetchMock = vi.spyOn(global, 'fetch')
      await expect(provider.fetch('https://a.com', {})).rejects.toThrow(/not signed into Gamut/i)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('maps a 402 to a billing message', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('blocked', { status: 402 }))
      await expect(provider.fetch('https://a.com', {})).rejects.toThrow(/billing issue/i)
    })

    it.each([401, 403])('maps a %i (revoked/expired token) to a sign-in-again message', async (status) => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status }))
      await expect(provider.fetch('https://a.com', {})).rejects.toThrow(/session has expired or is invalid.*sign in again/i)
    })

    it('passes a non-mapped proxy error through unchanged', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }))
      await expect(provider.fetch('https://a.com', {})).rejects.toThrow(/request failed: 404/i)
    })
  })

  // Platform is login-based; /validate-web-key rejects it before dispatch. Guards against a future
  // edit turning this into a live, billable proxy probe.
  it('validateKey answers from the login model without a network call', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
    await expect(provider.validateKey()).resolves.toEqual({
      valid: false,
      error: 'Platform uses your Gamut login, not an API key.',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
