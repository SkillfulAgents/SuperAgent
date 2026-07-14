import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@shared/lib/services/platform-auth-service', () => ({ getPlatformAccessToken: vi.fn() }))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: vi.fn(() => 'https://proxy.gamut.test'),
}))

import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import { NonRetryableError } from '../utils/retry'
import { mapPlatformWebError, PlatformWebProvider } from './platform-web-provider'

const searchBody = { results: [{ url: 'https://a.com', title: 'A', highlights: ['hi'] }] }
const contentsBody = { results: [{ url: 'https://a.com', title: 'A', text: 'full page' }] }

// Each status the proxy returns carries a different remedy, so each gets its own copy. The
// provider's own tests below prove only that its catch block runs this mapper.
describe('mapPlatformWebError', () => {
  it('maps 401 (expired/revoked token) to a sign-in-again message naming the surface', () => {
    const out = mapPlatformWebError(new NonRetryableError('x', 401), 'search')
    expect(out).toBeInstanceOf(Error)
    expect((out as Error).message).toMatch(/web search is unavailable.*session has expired or is invalid.*Sign in again/i)
  })

  // The proxy returns 403 for trial-ended / inactive-member / wrong-org, none of which signing in
  // again resolves. Telling the user to sign in there is worse than saying nothing.
  it('maps 403 (no account access) to account copy, NOT sign-in-again', () => {
    const out = mapPlatformWebError(new NonRetryableError('x', 403), 'search')
    const message = (out as Error).message
    expect(message).toMatch(/does not have access.*trial may have ended.*membership is inactive/i)
    expect(message).toMatch(/Check your account/i)
    expect(message).not.toMatch(/sign in again/i)
  })

  it('maps 402 to a billing message naming the surface', () => {
    const out = mapPlatformWebError(new NonRetryableError('x', 402), 'fetch')
    expect((out as Error).message).toMatch(/web fetch is unavailable.*billing issue/i)
  })

  it('passes a non-mapped NonRetryableError through unchanged', () => {
    const err = new NonRetryableError('Platform request failed: 404', 404)
    expect(mapPlatformWebError(err, 'search')).toBe(err)
  })

  it('passes a non-NonRetryableError (e.g. a network Error) through unchanged', () => {
    const err = new Error('network down')
    expect(mapPlatformWebError(err, 'fetch')).toBe(err)
  })
})

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

    // Exhaustive status->message coverage lives in the mapPlatformWebError block above. This proves
    // the wiring: an HTTP status becomes NonRetryableError.status and search's own catch maps it.
    it('maps a 403 (trial ended / inactive member) to account copy, not sign-in-again', async () => {
      vi.mocked(getPlatformAccessToken).mockReturnValue('tok-123')
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 403 }))
      await expect(provider.search('x', {})).rejects.toThrow(/does not have access.*Check your account/i)
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
      const body = JSON.parse(init!.body as string)
      expect(body).toMatchObject({
        urls: ['https://a.com'],
        filterEmptyResults: false,
      })
      // No maxChars asked for: `text` must be a bare `true` (full text), not a cap object.
      expect(body.text).toBe(true)
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
