import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockValidateProxyToken = vi.fn()
const mockGetActiveWebSearchProvider = vi.fn()
const mockGetSettings = vi.fn()

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...a: unknown[]) => mockValidateProxyToken(...a),
}))
vi.mock('@shared/lib/web-provider', () => ({
  getActiveWebSearchProvider: () => mockGetActiveWebSearchProvider(),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
}))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import xAgentWeb from './x-agent-web'

function makeApp() {
  const app = new Hono()
  app.route('/api/x-agent/web', xAgentWeb)
  return app
}

function search(body: unknown, headers: Record<string, string> = { Authorization: 'Bearer good' }) {
  return makeApp().request('http://localhost/api/x-agent/web/search', {
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

describe('POST /api/x-agent/web/search', () => {
  it('401 without an Authorization header', async () => {
    const res = await makeApp().request('http://localhost/api/x-agent/web/search', {
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
    mockGetActiveWebSearchProvider.mockReturnValue(null)
    const res = await search({ query: 'q' })
    expect(res.status).toBe(400)
  })

  it('400 when the body is missing a query', async () => {
    mockGetActiveWebSearchProvider.mockReturnValue({ search: vi.fn() })
    const res = await search({})
    expect(res.status).toBe(400)
  })

  it('returns hits on success and forwards options to the provider', async () => {
    const searchFn = vi.fn().mockResolvedValue({ hits: [{ url: 'https://a.com', title: 'A', snippet: 's' }] })
    mockGetActiveWebSearchProvider.mockReturnValue({ search: searchFn })
    const res = await search({ query: 'cats', numResults: 3 })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.hits[0].url).toBe('https://a.com')
    expect(searchFn).toHaveBeenCalledWith('cats', expect.objectContaining({ numResults: 3 }))
  })

  it('applies the allowed-sites policy and warns about removed results', async () => {
    mockGetActiveWebSearchProvider.mockReturnValue({
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
    mockGetActiveWebSearchProvider.mockReturnValue({ search: vi.fn().mockRejectedValue(new Error('vendor down')) })
    const res = await search({ query: 'q' })
    expect(res.status).toBe(502)
  })
})
