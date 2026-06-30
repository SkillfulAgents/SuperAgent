import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({ apiKeys: { firecrawlApiKey: 'test-key' } })),
}))

vi.mock('@shared/lib/utils/retry', async (orig) => {
  const actual = await orig<typeof import('@shared/lib/utils/retry')>()
  return { ...actual, withRetry: (fn: () => Promise<unknown>, max?: number) => actual.withRetry(fn, max, 0) }
})

import { getSettings } from '@shared/lib/config/settings'
import { FirecrawlWebSearchProvider, mapFirecrawlSearchResponse } from './firecrawl-web-search-provider'

function mockSettings(apiKeys: { firecrawlApiKey?: string }) {
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
  mockSettings({ firecrawlApiKey: 'test-key' })
})

describe('mapFirecrawlSearchResponse', () => {
  it('maps url, title and description (snippet); web results carry no date', () => {
    const res = mapFirecrawlSearchResponse({
      data: { web: [{ url: 'https://example.com/a', title: 'A', description: 'a snippet' }] },
    })
    expect(res.hits[0]).toEqual({ url: 'https://example.com/a', title: 'A', snippet: 'a snippet' })
    expect('publishedDate' in res.hits[0]).toBe(false)
  })

  it('maps a null title to null and an absent description to an empty snippet', () => {
    const res = mapFirecrawlSearchResponse({ data: { web: [{ url: 'https://x.com', title: null }] } })
    expect(res.hits[0].title).toBeNull()
    expect(res.hits[0].snippet).toBe('')
  })

  it('returns an empty hit list when there is no web array', () => {
    expect(mapFirecrawlSearchResponse({ success: true, data: {} }).hits).toEqual([])
  })

  it('throws on a malformed response (boundary validation)', () => {
    expect(() => mapFirecrawlSearchResponse({ data: { web: [{ title: 'no url' }] } })).toThrow()
  })
})

describe('FirecrawlWebSearchProvider.search', () => {
  it('posts to /v2/search with a Bearer token and the mapped body', async () => {
    const fetchMock = mockFetch({ data: { web: [{ url: 'https://r.com', title: 'R', description: 'hit' }] } })
    await new FirecrawlWebSearchProvider().search('cats', {
      numResults: 5,
      includeDomains: ['a.com'],
      excludeDomains: ['b.com'],
      startPublishedDate: '2024-01-01',
      endPublishedDate: '2024-12-31',
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.firecrawl.dev/v2/search')
    expect(init.method).toBe('POST')
    expect(init.headers['Authorization']).toBe('Bearer test-key')
    const body = JSON.parse(init.body)
    expect(body.query).toBe('cats')
    expect(body.limit).toBe(5)
    // include + exclude are mutually exclusive → include wins, exclude dropped.
    expect(body.includeDomains).toEqual(['a.com'])
    expect(body.excludeDomains).toBeUndefined()
    // dates → tbs custom range in US M/D/YYYY form (non-padded).
    expect(body.tbs).toBe('cdr:1,cd_min:1/1/2024,cd_max:12/31/2024')
    // no scrapeOptions / sources → avoids the formats oneOf trap and the page-failure trap.
    expect(body.scrapeOptions).toBeUndefined()
  })

  it('sends excludeDomains when only excludeDomains is provided', async () => {
    const fetchMock = mockFetch({ data: { web: [] } })
    await new FirecrawlWebSearchProvider().search('q', { excludeDomains: ['spam.com'] })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.excludeDomains).toEqual(['spam.com'])
    expect(body.includeDomains).toBeUndefined()
  })

  it('omits tbs when no date bounds are set', async () => {
    const fetchMock = mockFetch({ data: { web: [] } })
    await new FirecrawlWebSearchProvider().search('q', {})
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.tbs).toBeUndefined()
    expect(body.limit).toBe(10)
  })

  it('clamps numResults to the host hard max', async () => {
    const fetchMock = mockFetch({ data: { web: [] } })
    await new FirecrawlWebSearchProvider().search('q', { numResults: 1000 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).limit).toBeLessThanOrEqual(25)
  })

  it('throws a clear error when no api key is configured', async () => {
    mockSettings({})
    mockFetch({ data: { web: [] } })
    await expect(new FirecrawlWebSearchProvider().search('q', {})).rejects.toThrow(/key/i)
  })

  it('retries once on a 429 then succeeds', async () => {
    const fetchMock = mockFetchSequence([
      { ok: false, status: 429 },
      { ok: true, json: { data: { web: [{ url: 'https://r.com', title: 'R', description: 'hit' }] } } },
    ])
    const res = await new FirecrawlWebSearchProvider().search('q', {})
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.hits[0].url).toBe('https://r.com')
  })

  it('does NOT retry a 4xx config error (e.g. 401)', async () => {
    const fetchMock = mockFetchSequence([{ ok: false, status: 401 }])
    await expect(new FirecrawlWebSearchProvider().search('q', {})).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('FirecrawlWebSearchProvider degrade warnings', () => {
  it('warns when include and exclude domains are both set (exclude dropped)', async () => {
    mockFetch({ data: { web: [] } })
    const res = await new FirecrawlWebSearchProvider().search('q', { includeDomains: ['a.com'], excludeDomains: ['b.com'] })
    expect(res.warnings?.some((w) => /exclude/i.test(w))).toBe(true)
  })
})

describe('FirecrawlWebSearchProvider.validateKey', () => {
  it('returns valid for an authenticated key', async () => {
    mockFetch({ data: { web: [] } })
    expect(await new FirecrawlWebSearchProvider().validateKey('good')).toEqual({ valid: true })
  })

  it('returns invalid on 401', async () => {
    mockFetch({}, { ok: false, status: 401 })
    expect(await new FirecrawlWebSearchProvider().validateKey('bad')).toEqual({ valid: false, error: 'Invalid API key' })
  })
})
