import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockValidateProxyToken = vi.fn()
const mockGetActiveWebFetchProvider = vi.fn()
const mockGetSettings = vi.fn()

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...a: unknown[]) => mockValidateProxyToken(...a),
}))
vi.mock('@shared/lib/web-provider', () => ({
  getActiveWebFetchProvider: () => mockGetActiveWebFetchProvider(),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => mockGetSettings(),
}))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import webFetch from './web-fetch'

function makeApp() {
  const app = new Hono()
  app.route('/api/web-fetch', webFetch)
  return app
}

function fetchReq(body: unknown, headers: Record<string, string> = { Authorization: 'Bearer good' }) {
  return makeApp().request('http://localhost/api/web-fetch/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

function doc(over: Record<string, unknown> = {}) {
  return { url: 'https://a.com', title: 'A', content: 'body', fetchedAt: '2026-07-01T00:00:00.000Z', ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateProxyToken.mockResolvedValue('agent-slug')
  mockGetSettings.mockReturnValue({})
})

describe('POST /api/web-fetch/fetch', () => {
  it('401 without an Authorization header', async () => {
    const res = await makeApp().request('http://localhost/api/web-fetch/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"url":"https://a.com"}',
    })
    expect(res.status).toBe(401)
  })

  it('401 when the proxy token is invalid', async () => {
    mockValidateProxyToken.mockResolvedValue(null)
    const res = await fetchReq({ url: 'https://a.com' }, { Authorization: 'Bearer bad' })
    expect(res.status).toBe(401)
  })

  it('400 when no web fetch vendor is configured', async () => {
    mockGetActiveWebFetchProvider.mockReturnValue(null)
    const res = await fetchReq({ url: 'https://a.com' })
    expect(res.status).toBe(400)
  })

  it('400 when the body is missing a url', async () => {
    mockGetActiveWebFetchProvider.mockReturnValue({ fetch: vi.fn() })
    const res = await fetchReq({})
    expect(res.status).toBe(400)
  })

  it('400 when the url is not a valid URL', async () => {
    mockGetActiveWebFetchProvider.mockReturnValue({ fetch: vi.fn() })
    const res = await fetchReq({ url: 'not a url' })
    expect(res.status).toBe(400)
  })

  it('400 (and never dispatches) for a non-http(s) scheme', async () => {
    const fetchFn = vi.fn()
    mockGetActiveWebFetchProvider.mockReturnValue({ id: 'exa', fetch: fetchFn })
    const res = await fetchReq({ url: 'file:///etc/passwd' })
    expect(res.status).toBe(400)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns the document on success and forwards options to the provider', async () => {
    const fetchFn = vi.fn().mockResolvedValue(doc())
    mockGetActiveWebFetchProvider.mockReturnValue({ id: 'exa', fetch: fetchFn })
    const res = await fetchReq({ url: 'https://a.com', maxChars: 5000 })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.result.url).toBe('https://a.com')
    expect(json.result.content).toBe('body')
    expect(fetchFn).toHaveBeenCalledWith('https://a.com', expect.objectContaining({ maxChars: 5000 }))
  })

  it('rejects a target URL blocked by the allowed-sites policy BEFORE dispatch', async () => {
    const fetchFn = vi.fn()
    mockGetActiveWebFetchProvider.mockReturnValue({ id: 'exa', fetch: fetchFn })
    mockGetSettings.mockReturnValue({ webBlockedSites: ['a.com'] })
    const res = await fetchReq({ url: 'https://a.com/x' })
    expect(res.status).toBe(403)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('rejects a target URL not on a non-empty allow list BEFORE dispatch', async () => {
    const fetchFn = vi.fn()
    mockGetActiveWebFetchProvider.mockReturnValue({ id: 'exa', fetch: fetchFn })
    mockGetSettings.mockReturnValue({ webAllowedSites: ['nytimes.com'] })
    const res = await fetchReq({ url: 'https://a.com/x' })
    expect(res.status).toBe(403)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('502 when the provider throws', async () => {
    mockGetActiveWebFetchProvider.mockReturnValue({ id: 'exa', fetch: vi.fn().mockRejectedValue(new Error('vendor down')) })
    const res = await fetchReq({ url: 'https://a.com' })
    expect(res.status).toBe(502)
  })

  it('caps oversized content host-side and warns', async () => {
    const fetchFn = vi.fn().mockResolvedValue(doc({ content: 'x'.repeat(150_000) }))
    mockGetActiveWebFetchProvider.mockReturnValue({ id: 'exa', fetch: fetchFn })
    const res = await fetchReq({ url: 'https://a.com' })
    const json = await res.json()
    expect(json.result.content.length).toBe(100_000)
    expect(json.warnings.some((w: string) => /truncated/i.test(w))).toBe(true)
  })
})
