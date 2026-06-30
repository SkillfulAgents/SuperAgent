import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({ apiKeys: { parallelApiKey: 'test-key' } })),
}))

// Keep real retry logic but with zero backoff so retry behavior is exercised instantly.
vi.mock('@shared/lib/utils/retry', async (orig) => {
  const actual = await orig<typeof import('@shared/lib/utils/retry')>()
  return { ...actual, withRetry: (fn: () => Promise<unknown>, max?: number) => actual.withRetry(fn, max, 0) }
})

import { getSettings } from '@shared/lib/config/settings'
import { ParallelWebSearchProvider, mapParallelSearchResponse } from './parallel-web-search-provider'

function mockSettings(apiKeys: { parallelApiKey?: string }) {
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
  mockSettings({ parallelApiKey: 'test-key' })
})

describe('mapParallelSearchResponse', () => {
  it('maps url, title, publish_date and joined excerpts', () => {
    const res = mapParallelSearchResponse({
      results: [
        { url: 'https://example.com/a', title: 'A', publish_date: '2024-01-15', excerpts: ['one.', 'two.'] },
      ],
    })
    expect(res.hits[0]).toEqual({
      url: 'https://example.com/a',
      title: 'A',
      snippet: 'one. ... two.',
      publishedDate: '2024-01-15',
    })
  })

  it('uses an empty snippet when excerpts are absent', () => {
    const res = mapParallelSearchResponse({ results: [{ url: 'https://example.com/a', title: 'A' }] })
    expect(res.hits[0].snippet).toBe('')
  })

  it('keeps a null title as null', () => {
    const res = mapParallelSearchResponse({ results: [{ url: 'https://example.com/a', title: null, excerpts: ['x'] }] })
    expect(res.hits[0].title).toBeNull()
  })

  it('omits publishedDate when publish_date is null or absent', () => {
    const res = mapParallelSearchResponse({ results: [{ url: 'https://example.com/a', title: 'A', publish_date: null }] })
    expect('publishedDate' in res.hits[0]).toBe(false)
  })

  it('throws on a malformed response (boundary validation)', () => {
    expect(() => mapParallelSearchResponse({ results: [{ title: 'no url' }] })).toThrow()
  })
})

describe('ParallelWebSearchProvider.search', () => {
  it('posts to /v1/search with the api key and the advanced_settings envelope', async () => {
    const fetchMock = mockFetch({ results: [{ url: 'https://r.com', title: 'R', excerpts: ['hit'] }] })
    const res = await new ParallelWebSearchProvider().search('cats', {
      numResults: 5,
      includeDomains: ['a.com'],
      excludeDomains: ['b.com'],
      startPublishedDate: '2026-01-01T00:00:00.000Z',
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.parallel.ai/v1/search')
    expect(init.method).toBe('POST')
    expect(init.headers['x-api-key']).toBe('test-key')
    const body = JSON.parse(init.body)
    expect(body.objective).toBe('cats')
    expect(body.search_queries).toEqual(['cats'])
    // Knobs MUST nest under advanced_settings (additionalProperties:false rejects flat keys).
    expect(body.max_results).toBeUndefined()
    expect(body.advanced_settings.max_results).toBe(5)
    expect(body.advanced_settings.source_policy.include_domains).toEqual(['a.com'])
    expect(body.advanced_settings.source_policy.exclude_domains).toEqual(['b.com'])
    // ISO datetime truncated to a bare date for Parallel's `format: date` field.
    expect(body.advanced_settings.source_policy.after_date).toBe('2026-01-01')

    expect(res.hits[0]).toEqual({ url: 'https://r.com', title: 'R', snippet: 'hit' })
  })

  it('omits source_policy when no domain/date options are set', async () => {
    const fetchMock = mockFetch({ results: [] })
    await new ParallelWebSearchProvider().search('q', {})
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.advanced_settings.source_policy).toBeUndefined()
    expect(body.advanced_settings.max_results).toBe(10)
  })

  it('clamps numResults to the host hard max', async () => {
    const fetchMock = mockFetch({ results: [] })
    await new ParallelWebSearchProvider().search('q', { numResults: 1000 })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.advanced_settings.max_results).toBeLessThanOrEqual(25)
  })

  it('throws a clear error when no api key is configured', async () => {
    mockSettings({})
    mockFetch({ results: [] })
    await expect(new ParallelWebSearchProvider().search('q', {})).rejects.toThrow(/key/i)
  })

  it('retries once on a 429 then succeeds', async () => {
    const fetchMock = mockFetchSequence([
      { ok: false, status: 429 },
      { ok: true, json: { results: [{ url: 'https://r.com', title: 'R', excerpts: ['hit'] }] } },
    ])
    const res = await new ParallelWebSearchProvider().search('q', {})
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.hits[0].url).toBe('https://r.com')
  })

  it('does NOT retry a 4xx config error (e.g. 401)', async () => {
    const fetchMock = mockFetchSequence([{ ok: false, status: 401 }])
    await expect(new ParallelWebSearchProvider().search('q', {})).rejects.toThrow(/401/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('ParallelWebSearchProvider degrade warnings', () => {
  it('warns when endPublishedDate is dropped (Parallel has no end-date filter)', async () => {
    mockFetch({ results: [] })
    const res = await new ParallelWebSearchProvider().search('q', {
      startPublishedDate: '2026-01-01',
      endPublishedDate: '2026-06-30',
    })
    expect(res.warnings?.[0]).toMatch(/end-date/i)
  })

  it('does not warn when only startPublishedDate is set', async () => {
    mockFetch({ results: [] })
    const res = await new ParallelWebSearchProvider().search('q', { startPublishedDate: '2026-01-01' })
    expect(res.warnings).toBeUndefined()
  })
})

describe('ParallelWebSearchProvider.validateKey', () => {
  it('returns valid for an authenticated key', async () => {
    mockFetch({ results: [] })
    expect(await new ParallelWebSearchProvider().validateKey('good')).toEqual({ valid: true })
  })

  it('returns invalid on 401/403', async () => {
    mockFetch({}, { ok: false, status: 403 })
    expect(await new ParallelWebSearchProvider().validateKey('bad')).toEqual({ valid: false, error: 'Invalid API key' })
  })

  it('reports the status on other errors', async () => {
    mockFetch({}, { ok: false, status: 500 })
    const r = await new ParallelWebSearchProvider().validateKey('x')
    expect(r.valid).toBe(false)
    expect(r.error).toContain('500')
  })
})
