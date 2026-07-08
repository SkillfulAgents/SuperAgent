import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockValidateProxyToken = vi.fn()
const mockGetActiveWebProvider = vi.fn()
const mockGetSettings = vi.fn()

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...a: unknown[]) => mockValidateProxyToken(...a),
}))
vi.mock('@shared/lib/web-provider', () => ({
  getActiveWebProvider: () => mockGetActiveWebProvider(),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
}))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import webSearch from './web-search'

function makeApp() {
  const app = new Hono()
  app.route('/api/web-search', webSearch)
  return app
}

function search(body: unknown, headers: Record<string, string> = { Authorization: 'Bearer good' }) {
  return makeApp().request('http://localhost/api/web-search/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateProxyToken.mockResolvedValue('agent-slug')
  mockGetSettings.mockReturnValue({})
})

describe('POST /api/web-search/search', () => {
  it('401 without an Authorization header', async () => {
    const res = await makeApp().request('http://localhost/api/web-search/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"query":"q"}',
    })
    expect(res.status).toBe(401)
  })

  it('401 when the proxy token is invalid', async () => {
    mockValidateProxyToken.mockResolvedValue(null)
    const res = await search({ query: 'q' }, { Authorization: 'Bearer bad' })
    expect(res.status).toBe(401)
  })

  it('400 when no web search vendor is configured', async () => {
    mockGetActiveWebProvider.mockReturnValue(null)
    const res = await search({ query: 'q' })
    expect(res.status).toBe(400)
  })

  it('400 when the body is missing a query', async () => {
    mockGetActiveWebProvider.mockReturnValue({ search: vi.fn() })
    const res = await search({})
    expect(res.status).toBe(400)
  })

  it('returns hits on success and forwards options to the provider', async () => {
    const searchFn = vi.fn().mockResolvedValue({ hits: [{ url: 'https://a.com', title: 'A', snippet: 's' }] })
    mockGetActiveWebProvider.mockReturnValue({ search: searchFn })
    const res = await search({ query: 'cats', numResults: 3 })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.hits[0].url).toBe('https://a.com')
    expect(searchFn).toHaveBeenCalledWith('cats', expect.objectContaining({ numResults: 3 }))
  })

  it('applies the allowed-sites policy and warns about removed results', async () => {
    mockGetActiveWebProvider.mockReturnValue({
      search: vi.fn().mockResolvedValue({
        hits: [
          { url: 'https://a.com/x', title: 'A', snippet: 's' },
          { url: 'https://b.com/y', title: 'B', snippet: 's' },
        ],
      }),
    })
    mockGetSettings.mockReturnValue({ webBlockedSites: ['a.com'] })
    const res = await search({ query: 'q' })
    const json = await res.json()
    expect(json.hits.map((h: { url: string }) => h.url)).toEqual(['https://b.com/y'])
    expect(json.warnings[0]).toMatch(/removed/)
  })

  it('502 when the provider throws', async () => {
    mockGetActiveWebProvider.mockReturnValue({ search: vi.fn().mockRejectedValue(new Error('vendor down')) })
    const res = await search({ query: 'q' })
    expect(res.status).toBe(502)
  })

  it('400 when the query exceeds the max length', async () => {
    mockGetActiveWebProvider.mockReturnValue({ search: vi.fn() })
    const res = await search({ query: 'x'.repeat(2001) })
    expect(res.status).toBe(400)
  })

  it('caps the hit count and truncates oversized snippets host-side', async () => {
    const hits = Array.from({ length: 60 }, (_, i) => ({ url: `https://a.com/${i}`, title: 'A', snippet: 'x'.repeat(3000) }))
    mockGetActiveWebProvider.mockReturnValue({ search: vi.fn().mockResolvedValue({ hits }) })
    const res = await search({ query: 'q' })
    const json = await res.json()
    expect(json.hits.length).toBe(50)
    expect(json.hits[0].snippet.length).toBe(2000)
    expect(json.warnings.some((w: string) => /first 50 of 60/.test(w))).toBe(true)
  })
})
