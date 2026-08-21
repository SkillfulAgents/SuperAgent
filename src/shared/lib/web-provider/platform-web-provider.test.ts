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
  beforeEach(() => {
    vi.restoreAllMocks()
    delete process.env.PLATFORM_TOKEN
  })

  describe('search', () => {
    it('POSTs to the proxy with Bearer + Exa body, mapping the response', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      const fetchMock = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify(searchBody), { status: 200 }))
      const res = await provider.search('cats', {
        numResults: 5,
        includeDomains: ['a.com'],
        excludeDomains: ['b.com'],
        startPublishedDate: '2024-01-01',
        endPublishedDate: '2024-12-31',
      })
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://proxy.gamut.test/v1/exa/search')
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
      expect((init!.headers as Record<string, string>)['x-api-key']).toBeUndefined()
      expect(JSON.parse(init!.body as string)).toMatchObject({
        query: 'cats',
        numResults: 5,
        includeDomains: ['a.com'],
        excludeDomains: ['b.com'],
        startPublishedDate: '2024-01-01',
        endPublishedDate: '2024-12-31',
        contents: { highlights: true, text: { maxCharacters: 800 } },
      })
      expect(res.hits[0]).toMatchObject({ url: 'https://a.com', title: 'A', snippet: 'hi' })
    })

    it('pre-guards when not signed in (no network call)', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue(null)
      const fetchMock = vi.spyOn(global, 'fetch')
      await expect(provider.search('x', {})).rejects.toThrow(/not signed into Gamut/i)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([
      [401, /web search is unavailable.*session has expired or is invalid.*Sign in again/i],
      [403, /does not have access.*Check your account/i],
      [402, /web search is unavailable.*billing issue/i],
    ] as const)('maps proxy %i to actionable copy', async (status, pattern) => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status }))
      try {
        await provider.search('x', {})
        expect.unreachable()
      } catch (e) {
        const message = (e as Error).message
        expect(message).toMatch(pattern)
        if (status === 403) expect(message).not.toMatch(/sign in again/i)
      }
    })
  })

  describe('fetch', () => {
    it('POSTs to the proxy contents path with Bearer + Exa contents body', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      const fetchMock = vi
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(contentsBody), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(contentsBody), { status: 200 }))
      const res = await provider.fetch('https://a.com', {})
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://proxy.gamut.test/v1/exa/contents')
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok-123')
      const body = JSON.parse(init!.body as string)
      expect(body).toMatchObject({ urls: ['https://a.com'], filterEmptyResults: false })
      expect(body.text).toBe(true)
      expect(res).toMatchObject({ url: 'https://a.com', title: 'A', content: 'full page' })

      await provider.fetch('https://a.com', { maxChars: 500 })
      expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).text).toEqual({ maxCharacters: 500 })
    })

    it('maps 402 on fetch to billing copy naming the surface', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 402 }))
      await expect(provider.fetch('https://a.com', {})).rejects.toThrow(
        /web fetch is unavailable.*billing issue/i,
      )
    })

    it('pre-guards when not signed in (no network call)', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue(null)
      const fetchMock = vi.spyOn(global, 'fetch')
      await expect(provider.fetch('https://a.com', {})).rejects.toThrow(/not signed into Gamut/i)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
