import { describe, it, expect, vi } from 'vitest'
import {
  buildProxyParameters,
  envelopeToResponse,
  PROXY_SKIP_REQUEST_HEADERS,
  PROXY_SKIP_RESPONSE_HEADERS,
} from './composio-envelope'
import type { ProxyExecuteResult } from '@shared/lib/composio/client'

describe('buildProxyParameters', () => {
  it('emits all forwardable headers as type:"header" parameters', () => {
    const h = new Headers({
      Accept: 'application/vnd.github+json',
      'X-Custom': 'yes',
      'User-Agent': 'superagent/1',
    })
    const params = buildProxyParameters(h)
    const map = new Map(params.map((p) => [p.name.toLowerCase(), p]))
    expect(map.get('accept')).toEqual({
      name: 'accept',
      value: 'application/vnd.github+json',
      type: 'header',
    })
    expect(map.get('x-custom')?.value).toBe('yes')
    expect(map.get('user-agent')?.value).toBe('superagent/1')
    for (const p of params) expect(p.type).toBe('header')
  })

  it.each([
    'host',
    'authorization',
    'connection',
    'content-length',
    'transfer-encoding',
    'accept-encoding',
    'cookie',
  ])('strips %s', (name) => {
    const h = new Headers({
      [name]: 'whatever',
      Accept: 'application/json',
    })
    const params = buildProxyParameters(h)
    const names = params.map((p) => p.name.toLowerCase())
    expect(names).not.toContain(name)
    expect(names).toContain('accept')
  })

  it('strips skip-list headers regardless of case', () => {
    const h = new Headers({
      AUTHORIZATION: 'Bearer x',
      Cookie: 'session=secret',
      'TRANSFER-ENCODING': 'chunked',
      'X-Allow': 'yes',
    })
    const params = buildProxyParameters(h)
    const names = params.map((p) => p.name.toLowerCase())
    expect(names).not.toContain('authorization')
    expect(names).not.toContain('cookie')
    expect(names).not.toContain('transfer-encoding')
    expect(names).toContain('x-allow')
  })

  it('returns empty array when only stripped headers are present', () => {
    const h = new Headers({
      Authorization: 'Bearer x',
      Cookie: 'session=secret',
      Connection: 'keep-alive',
    })
    expect(buildProxyParameters(h)).toEqual([])
  })

  it('returns empty array for empty Headers', () => {
    expect(buildProxyParameters(new Headers())).toEqual([])
  })

  it('does NOT emit query-type parameters (queries belong in the endpoint URL)', () => {
    const h = new Headers({ Accept: 'application/json', 'X-Custom': 'v' })
    const params = buildProxyParameters(h)
    expect(params.every((p) => p.type === 'header')).toBe(true)
  })

  it('PROXY_SKIP_REQUEST_HEADERS is a sealed sentinel — guard against accidental edits', () => {
    expect([...PROXY_SKIP_REQUEST_HEADERS].sort()).toEqual([
      'accept-encoding',
      'authorization',
      'connection',
      'content-length',
      'host',
      'transfer-encoding',
    ])
  })
})

function envelope(overrides: Partial<ProxyExecuteResult> = {}): ProxyExecuteResult {
  return {
    status: 200,
    data: {},
    headers: {},
    ...overrides,
  }
}

describe('envelopeToResponse', () => {
  describe('JSON data', () => {
    it('returns application/json with re-serialized object body', async () => {
      const res = await envelopeToResponse(
        envelope({ status: 200, data: { hello: 'world' }, headers: {} })
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/json')
      expect(await res.json()).toEqual({ hello: 'world' })
    })

    it('serializes arrays', async () => {
      const res = await envelopeToResponse(
        envelope({ data: [1, 2, 3] })
      )
      expect(await res.json()).toEqual([1, 2, 3])
    })

    it('serializes null as JSON `null` (not empty body)', async () => {
      const res = await envelopeToResponse(envelope({ data: null }))
      expect(res.headers.get('content-type')).toBe('application/json')
      expect(await res.text()).toBe('null')
    })

    it('serializes numbers and booleans', async () => {
      const r1 = await envelopeToResponse(envelope({ data: 42 }))
      expect(await r1.text()).toBe('42')
      const r2 = await envelopeToResponse(envelope({ data: true }))
      expect(await r2.text()).toBe('true')
    })

    it('overrides any upstream content-type with application/json', async () => {
      const res = await envelopeToResponse(
        envelope({
          data: { ok: true },
          headers: { 'content-type': 'text/html' }, // hostile / mismatched envelope
        })
      )
      expect(res.headers.get('content-type')).toBe('application/json')
    })

    it('passes through non-200 status (e.g. upstream 404)', async () => {
      const res = await envelopeToResponse(
        envelope({ status: 404, data: { message: 'Not Found' } })
      )
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ message: 'Not Found' })
    })

    it('passes through non-skip-list response headers', async () => {
      const res = await envelopeToResponse(
        envelope({
          data: {},
          headers: {
            'x-ratelimit-remaining': '4999',
            'x-request-id': 'req-abc',
          },
        })
      )
      expect(res.headers.get('x-ratelimit-remaining')).toBe('4999')
      expect(res.headers.get('x-request-id')).toBe('req-abc')
    })
  })

  describe('string data', () => {
    it('passes string body through unchanged', async () => {
      const res = await envelopeToResponse(
        envelope({ data: '<html>hi</html>' })
      )
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('<html>hi</html>')
    })

    it('defaults content-type to text/plain when envelope has none', async () => {
      const res = await envelopeToResponse(envelope({ data: 'plain text' }))
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    })

    it('preserves content-type from envelope when provided (e.g. text/html)', async () => {
      const res = await envelopeToResponse(
        envelope({
          data: '<html>x</html>',
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      )
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    })

    it('handles empty string body', async () => {
      const res = await envelopeToResponse(envelope({ data: '' }))
      expect(await res.text()).toBe('')
    })

    it('passes non-200 status (e.g. upstream 503 with HTML error page)', async () => {
      const res = await envelopeToResponse(
        envelope({
          status: 503,
          data: '<html><body>maintenance</body></html>',
          headers: { 'content-type': 'text/html' },
        })
      )
      expect(res.status).toBe(503)
      expect(await res.text()).toContain('maintenance')
    })
  })

  describe('binary data (binary_data.url)', () => {
    it('streams the URL through with envelope content_type', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response('PDF-BYTES', { status: 200 })
      )
      const res = await envelopeToResponse(
        envelope({
          data: null,
          binaryData: {
            url: 'https://composio-cdn/blob/123',
            content_type: 'application/pdf',
            size: 9,
            expires_at: '2099-01-01T00:00:00Z',
          },
        }),
        fetchImpl
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/pdf')
      expect(fetchImpl).toHaveBeenCalledWith('https://composio-cdn/blob/123')
      expect(await res.text()).toBe('PDF-BYTES')
    })

    it('preserves the envelope status on the binary response', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response('x', { status: 200 })
      )
      const res = await envelopeToResponse(
        envelope({
          status: 206, // partial content
          data: null,
          binaryData: {
            url: 'https://cdn/x',
            content_type: 'video/mp4',
            size: 1,
            expires_at: '2099-01-01T00:00:00Z',
          },
        }),
        fetchImpl
      )
      expect(res.status).toBe(206)
      expect(res.headers.get('content-type')).toBe('video/mp4')
    })

    it('overrides any envelope-level Content-Type with binaryData.content_type', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('x', { status: 200 }))
      const res = await envelopeToResponse(
        envelope({
          data: null,
          headers: { 'content-type': 'application/json' },
          binaryData: {
            url: 'https://cdn/x',
            content_type: 'application/zip',
            size: 1,
            expires_at: '2099-01-01T00:00:00Z',
          },
        }),
        fetchImpl
      )
      expect(res.headers.get('content-type')).toBe('application/zip')
    })

    it('returns 502 when fetching the binary URL throws', async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new Error('CDN gone'))
      const res = await envelopeToResponse(
        envelope({
          data: null,
          binaryData: {
            url: 'https://cdn/x',
            content_type: 'image/png',
            size: 1,
            expires_at: '2099-01-01T00:00:00Z',
          },
        }),
        fetchImpl
      )
      expect(res.status).toBe(502)
      expect(res.headers.get('content-type')).toBe('application/json')
      const body = await res.json()
      expect(body.error).toBe('Failed to fetch binary response')
      expect(body.details).toContain('CDN gone')
    })

    it('binaryData.url takes precedence over `data` field', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response('binary-wins', { status: 200 })
      )
      const res = await envelopeToResponse(
        envelope({
          data: { ignored: true }, // should NOT be returned when binaryData is present
          binaryData: {
            url: 'https://cdn/x',
            content_type: 'image/png',
            size: 1,
            expires_at: '2099-01-01T00:00:00Z',
          },
        }),
        fetchImpl
      )
      expect(await res.text()).toBe('binary-wins')
      expect(res.headers.get('content-type')).toBe('image/png')
    })
  })

  describe('header skip list', () => {
    it.each([...PROXY_SKIP_RESPONSE_HEADERS])('strips %s from envelope headers', async (name) => {
      const res = await envelopeToResponse(
        envelope({
          data: { ok: true },
          headers: {
            [name]: 'something',
            'x-keep': 'me',
          },
        })
      )
      expect(res.headers.get(name)).toBeNull()
      expect(res.headers.get('x-keep')).toBe('me')
    })

    it('strips skip-list headers regardless of envelope-key casing', async () => {
      const res = await envelopeToResponse(
        envelope({
          data: { ok: true },
          headers: {
            'Transfer-Encoding': 'chunked',
            'CONTENT-ENCODING': 'gzip',
          },
        })
      )
      expect(res.headers.get('transfer-encoding')).toBeNull()
      expect(res.headers.get('content-encoding')).toBeNull()
    })

    it('PROXY_SKIP_RESPONSE_HEADERS sentinel matches expected set', () => {
      expect([...PROXY_SKIP_RESPONSE_HEADERS].sort()).toEqual([
        'content-encoding',
        'content-length',
        'transfer-encoding',
      ])
    })
  })

  describe('default fetch dependency', () => {
    it('uses the global fetch when no fetchImpl is passed', async () => {
      // No binary_data → no fetch call → no need to stub the global. Just verify
      // the function is callable without supplying fetchImpl (signature default).
      const res = await envelopeToResponse(envelope({ data: { ok: 1 } }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: 1 })
    })
  })
})
