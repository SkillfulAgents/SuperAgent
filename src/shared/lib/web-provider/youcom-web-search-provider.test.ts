import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({ apiKeys: { youComApiKey: 'test-key' } })),
}))

vi.mock('@shared/lib/utils/retry', async (orig) => {
  const actual = await orig<typeof import('@shared/lib/utils/retry')>()
  return { ...actual, withRetry: (fn: () => Promise<unknown>, max?: number) => actual.withRetry(fn, max, 0) }
})

import { getSettings } from '@shared/lib/config/settings'
import { YouComWebSearchProvider, mapYouSearchResponse } from './youcom-web-search-provider'

function mockSettings(apiKeys: { youComApiKey?: string }) {
  vi.mocked(getSettings).mockReturnValue({ apiKeys } as unknown as ReturnType<typeof getSettings>)
}

function mockFetch(json: unknown, { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status, statusText: ok ? 'OK' : 'Error', json: async () => json })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function mockFetchSequence(responses: Array<{ json?: unknown; ok?: boolean; status?: number }>) {
  const fetchMock = vi.fn()
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: (r.ok ?? true) ? 'OK' : 'Error',
      json: async () => r.json ?? {},
    })
  }
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  mockSettings({ youComApiKey: 'test-key' })
})

describe('mapYouSearchResponse', () => {
  it('maps url, title, page_age and a snippet joined from description + snippets', () => {
    const res = mapYouSearchResponse({
      results: {
        web: [
          { url: 'https://example.com/a', title: 'A', description: 'desc.', snippets: ['one.', 'two.'], page_age: '2025-11-30T04:39:48' },
        ],
      },
    })
    expect(res.hits[0]).toEqual({
      url: 'https://example.com/a',
      title: 'A',
      snippet: 'desc. one. two.',
      publishedDate: '2025-11-30T04:39:48',
    })
  })

  it('falls back to description-only when there are no snippets', () => {
    const res = mapYouSearchResponse({ results: { web: [{ url: 'https://x.com', title: 'X', description: 'only desc' }] } })
    expect(res.hits[0].snippet).toBe('only desc')
  })

  it('maps a null title from an absent title field', () => {
    const res = mapYouSearchResponse({ results: { web: [{ url: 'https://x.com', description: 'd' }] } })
    expect(res.hits[0].title).toBeNull()
  })

  it('omits publishedDate when page_age is absent', () => {
    const res = mapYouSearchResponse({ results: { web: [{ url: 'https://x.com', title: 'X', description: 'd' }] } })
    expect('publishedDate' in res.hits[0]).toBe(false)
  })

  it('drops a web result that has no url (cannot form a hit)', () => {
    const res = mapYouSearchResponse({ results: { web: [{ title: 'no url', description: 'd' }, { url: 'https://ok.com', title: 'ok' }] } })
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0].url).toBe('https://ok.com')
  })

  it('returns an empty hit list when there is no web array', () => {
    expect(mapYouSearchResponse({ results: {} }).hits).toEqual([])
  })
})

describe('YouComWebSearchProvider.search', () => {
  it('GETs ydc-index.io/v1/search with the X-API-Key header and mapped query params', async () => {
    const fetchMock = mockFetch({ results: { web: [{ url: 'https://r.com', title: 'R', description: 'hit' }] } })
    await new YouComWebSearchProvider().search('cats', {
      numResults: 5,
      includeDomains: ['a.com', 'b.com'],
      excludeDomains: ['c.com'],
      startPublishedDate: '2026-01-01T00:00:00.000Z',
      endPublishedDate: '2026-06-30',
    })

    const [calledUrl, init] = fetchMock.mock.calls[0]
    const u = new URL(calledUrl)
    expect(u.origin + u.pathname).toBe('https://ydc-index.io/v1/search')
    expect(init.method).toBe('GET')
    expect(init.headers['X-API-Key']).toBe('test-key')
    expect(u.searchParams.get('query')).toBe('cats')
    expect(u.searchParams.get('count')).toBe('5')
    // include + exclude together is a 422 — send include, drop exclude (host-filter handles excludes).
    expect(u.searchParams.get('include_domains')).toBe('a.com,b.com')
    expect(u.searchParams.get('exclude_domains')).toBeNull()
    // both date ends present → a `YYYY-MM-DDtoYYYY-MM-DD` freshness range.
    expect(u.searchParams.get('freshness')).toBe('2026-01-01to2026-06-30')
  })

  it('sends exclude_domains when only excludeDomains is provided', async () => {
    const fetchMock = mockFetch({ results: { web: [] } })
    await new YouComWebSearchProvider().search('q', { excludeDomains: ['spam.com'] })
    const u = new URL(fetchMock.mock.calls[0][0])
    expect(u.searchParams.get('exclude_domains')).toBe('spam.com')
    expect(u.searchParams.get('include_domains')).toBeNull()
  })

  it('omits freshness when only one date bound is provided (one-sided range is undocumented)', async () => {
    const fetchMock = mockFetch({ results: { web: [] } })
    await new YouComWebSearchProvider().search('q', { startPublishedDate: '2026-01-01' })
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('freshness')).toBeNull()
  })

  it('throws a clear error when no api key is configured', async () => {
    mockSettings({})
    mockFetch({ results: { web: [] } })
    await expect(new YouComWebSearchProvider().search('q', {})).rejects.toThrow(/key/i)
  })

  it('retries once on a 429 then succeeds', async () => {
    const fetchMock = mockFetchSequence([
      { ok: false, status: 429 },
      { ok: true, json: { results: { web: [{ url: 'https://r.com', title: 'R', description: 'hit' }] } } },
    ])
    const res = await new YouComWebSearchProvider().search('q', {})
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.hits[0].url).toBe('https://r.com')
  })

  it('does NOT retry a 4xx config error (e.g. 401)', async () => {
    const fetchMock = mockFetchSequence([{ ok: false, status: 401 }])
    await expect(new YouComWebSearchProvider().search('q', {})).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('YouComWebSearchProvider.validateKey', () => {
  it('returns valid for an authenticated key', async () => {
    mockFetch({ results: { web: [] } })
    expect(await new YouComWebSearchProvider().validateKey('good')).toEqual({ valid: true })
  })

  it('returns invalid on 401/403', async () => {
    mockFetch({}, { ok: false, status: 403 })
    expect(await new YouComWebSearchProvider().validateKey('bad')).toEqual({ valid: false, error: 'Invalid API key' })
  })
})
