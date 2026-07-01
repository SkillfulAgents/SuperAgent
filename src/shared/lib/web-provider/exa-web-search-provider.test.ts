import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({ apiKeys: { exaApiKey: 'test-key' } })),
}))

// Keep real retry logic but with zero backoff so retry behavior is exercised instantly.
vi.mock('@shared/lib/utils/retry', async (orig) => {
  const actual = await orig<typeof import('@shared/lib/utils/retry')>()
  return { ...actual, withRetry: (fn: () => Promise<unknown>, max?: number) => actual.withRetry(fn, max, 0) }
})

import { getSettings } from '@shared/lib/config/settings'
import { ExaWebSearchProvider, mapExaSearchResponse } from './exa-web-search-provider'

function mockSettings(apiKeys: { exaApiKey?: string }) {
  vi.mocked(getSettings).mockReturnValue({ apiKeys } as unknown as ReturnType<typeof getSettings>)
}

function mockFetch(json: unknown, { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => json,
  })
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
  mockSettings({ exaApiKey: 'test-key' })
})

describe('mapExaSearchResponse', () => {
  it('maps url, title and publishedDate straight through', () => {
    const res = mapExaSearchResponse({
      results: [
        { url: 'https://example.com/a', title: 'A', publishedDate: '2026-06-01T00:00:00.000Z', highlights: ['x'] },
      ],
    })
    expect(res.hits[0]).toEqual({
      url: 'https://example.com/a',
      title: 'A',
      snippet: 'x',
      publishedDate: '2026-06-01T00:00:00.000Z',
    })
  })

  it('normalizes snippet from joined highlights', () => {
    const res = mapExaSearchResponse({
      results: [{ url: 'https://example.com/a', title: 'A', highlights: ['one.', 'two.'] }],
    })
    expect(res.hits[0].snippet).toBe('one. ... two.')
  })

  it('falls back to text when there are no highlights', () => {
    const res = mapExaSearchResponse({
      results: [{ url: 'https://example.com/a', title: 'A', text: 'body text' }],
    })
    expect(res.hits[0].snippet).toBe('body text')
  })

  it('uses an empty snippet when neither highlights nor text are present', () => {
    const res = mapExaSearchResponse({
      results: [{ url: 'https://example.com/a', title: 'A' }],
    })
    expect(res.hits[0].snippet).toBe('')
  })

  it('keeps a null title as null', () => {
    const res = mapExaSearchResponse({
      results: [{ url: 'https://example.com/a', title: null, highlights: ['x'] }],
    })
    expect(res.hits[0].title).toBeNull()
  })

  it('omits publishedDate when Exa does not return one', () => {
    const res = mapExaSearchResponse({
      results: [{ url: 'https://example.com/a', title: 'A', highlights: ['x'] }],
    })
    expect('publishedDate' in res.hits[0]).toBe(false)
  })

  it('returns an empty hit list for an empty result set', () => {
    const res = mapExaSearchResponse({ results: [] })
    expect(res.hits).toEqual([])
  })

  it('throws on a malformed response (boundary validation)', () => {
    expect(() => mapExaSearchResponse({ results: [{ title: 'no url' }] })).toThrow()
  })
})

describe('ExaWebSearchProvider.search', () => {
  it('calls Exa /search with the api key and a body built from the query + options', async () => {
    const fetchMock = mockFetch({ results: [{ url: 'https://r.com', title: 'R', highlights: ['hit'] }] })
    const hits = await new ExaWebSearchProvider().search('cats', {
      numResults: 5,
      includeDomains: ['a.com'],
      startPublishedDate: '2026-01-01',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.exa.ai/search')
    expect(init.method).toBe('POST')
    expect(init.headers['x-api-key']).toBe('test-key')
    const body = JSON.parse(init.body)
    expect(body.query).toBe('cats')
    expect(body.numResults).toBe(5)
    expect(body.includeDomains).toEqual(['a.com'])
    expect(body.startPublishedDate).toBe('2026-01-01')
    expect(body.contents).toBeDefined()

    expect(hits.hits[0]).toEqual({ url: 'https://r.com', title: 'R', snippet: 'hit' })
  })

  it('clamps numResults to the host hard max', async () => {
    const fetchMock = mockFetch({ results: [] })
    await new ExaWebSearchProvider().search('q', { numResults: 1000 })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.numResults).toBeLessThanOrEqual(25)
  })

  it('defaults numResults when the caller omits it', async () => {
    const fetchMock = mockFetch({ results: [] })
    await new ExaWebSearchProvider().search('q', {})
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.numResults).toBe(10)
  })

  it('throws a clear error when no api key is configured', async () => {
    mockSettings({})
    mockFetch({ results: [] })
    await expect(new ExaWebSearchProvider().search('q', {})).rejects.toThrow(/key/i)
  })

  it('retries once on a 429 then succeeds', async () => {
    const fetchMock = mockFetchSequence([
      { ok: false, status: 429 },
      { ok: true, status: 200, json: { results: [{ url: 'https://r.com', title: 'R', highlights: ['hit'] }] } },
    ])
    const res = await new ExaWebSearchProvider().search('q', {})
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.hits[0].url).toBe('https://r.com')
  })

  it('throws after the retry is exhausted on persistent 5xx', async () => {
    const fetchMock = mockFetchSequence([
      { ok: false, status: 503 },
      { ok: false, status: 503 },
    ])
    await expect(new ExaWebSearchProvider().search('q', {})).rejects.toThrow(/503/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 4xx config error (e.g. 401)', async () => {
    const fetchMock = mockFetchSequence([{ ok: false, status: 401 }])
    await expect(new ExaWebSearchProvider().search('q', {})).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('ExaWebSearchProvider.validateKey', () => {
  it('returns valid for an authenticated key', async () => {
    mockFetch({ results: [] })
    expect(await new ExaWebSearchProvider().validateKey('good')).toEqual({ valid: true })
  })

  it('returns invalid on 401/403', async () => {
    mockFetch({}, { ok: false, status: 401 })
    expect(await new ExaWebSearchProvider().validateKey('bad')).toEqual({ valid: false, error: 'Invalid API key' })
  })

  it('reports the status on other errors', async () => {
    mockFetch({}, { ok: false, status: 500 })
    const res = await new ExaWebSearchProvider().validateKey('x')
    expect(res.valid).toBe(false)
    expect(res.error).toContain('500')
  })

  it('reports a network error when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const res = await new ExaWebSearchProvider().validateKey('x')
    expect(res.valid).toBe(false)
    expect(res.error).toMatch(/network/i)
  })
})
