import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const mockValidateProxyToken = vi.fn()
const mockGetEffectiveReplicateKey = vi.fn()
const mockIsWhitelistedModel = vi.fn()
const mockGetWhitelistCatalog = vi.fn()

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (...a: unknown[]) => mockValidateProxyToken(...a),
}))
vi.mock('@shared/lib/replicate/credentials', () => ({
  getEffectiveReplicateKey: () => mockGetEffectiveReplicateKey(),
}))
vi.mock('@shared/lib/replicate/whitelist', () => ({
  isWhitelistedModel: (owner: string, name: string) => mockIsWhitelistedModel(owner, name),
  getWhitelistCatalog: () => mockGetWhitelistCatalog(),
}))

import replicate from './replicate'

const REAL_KEY = 'r8_real_key_for_tests'
const HASH = 'a'.repeat(64)
const QUALIFIED = `meta/musicgen:${HASH}`

function makeApp() {
  const app = new Hono()
  app.route('/api/replicate', replicate)
  return app
}

function req(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) {
  const headers = {
    Authorization: 'Bearer good',
    ...(init.headers ?? {}),
  }
  return makeApp().request(`http://localhost/api/replicate${path}`, { ...init, headers })
}

function mockVendorFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response> | Response) {
  const fetchMock = vi.fn(handler)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidateProxyToken.mockResolvedValue('agent-slug')
  mockGetEffectiveReplicateKey.mockReturnValue(REAL_KEY)
  mockIsWhitelistedModel.mockImplementation(
    (owner: string, name: string) => `${owner}/${name}` === 'meta/musicgen',
  )
  mockGetWhitelistCatalog.mockReturnValue([
    { category: 'Music', models: [{ model: 'meta/musicgen', official: false }] },
  ])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('auth', () => {
  it('401 without Authorization', async () => {
    const res = await makeApp().request('http://localhost/api/replicate/catalog')
    expect(res.status).toBe(401)
  })

  it('401 with bad bearer', async () => {
    mockValidateProxyToken.mockResolvedValue(null)
    const res = await req('/catalog', { headers: { Authorization: 'Bearer bad' } })
    expect(res.status).toBe(401)
  })
})

describe('GET /catalog', () => {
  it('returns grouped catalog JSON and works keyless', async () => {
    mockGetEffectiveReplicateKey.mockReturnValue(undefined)
    const res = await req('/catalog')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      categories: [{ category: 'Music', models: [{ model: 'meta/musicgen', official: false }] }],
    })
  })
})

describe('keyless vendor ops', () => {
  it('400 with Settings remedy copy', async () => {
    mockGetEffectiveReplicateKey.mockReturnValue(undefined)
    const fetchMock = mockVendorFetch(() => new Response('{}', { status: 200 }))
    const res = await req('/v1/models/meta/musicgen')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Settings → Media Generation/)
    // The skill branches on `remedy`, so the machine-readable half has to be there too.
    expect(body.remedy).toBe(body.error)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('allow/deny matrix', () => {
  it('allows the five vendor ops', async () => {
    const fetchMock = mockVendorFetch(
      () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )

    const allowed = [
      ['GET', '/v1/models/meta/musicgen'],
      ['POST', '/v1/models/meta/musicgen/predictions', { input: {} }],
      ['POST', '/v1/predictions', { version: QUALIFIED, input: {} }],
      ['GET', '/v1/predictions/abc-123'],
      ['POST', '/v1/predictions/abc-123/cancel'],
    ] as const

    for (const [method, path, body] of allowed) {
      fetchMock.mockClear()
      if (method === 'POST' && path === '/v1/predictions') {
        // verifier + create
        fetchMock
          .mockResolvedValueOnce(new Response('{}', { status: 200 }))
          .mockResolvedValueOnce(
            new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
          )
      } else {
        fetchMock.mockResolvedValueOnce(
          new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
        )
      }
      const res = await req(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      })
      expect(res.status, `${method} ${path}`).toBe(200)
    }
  })

  it('denies excluded surfaces with allowed table', async () => {
    const fetchMock = mockVendorFetch(() => new Response('{}', { status: 200 }))
    const denied = [
      ['GET', '/v1/account'],
      ['POST', '/v1/trainings'],
      ['GET', '/v1/predictions'],
      ['QUERY', '/v1/models'],
      ['GET', '/v1/collections'],
      // Same path shapes as allowed rows: the table is keyed on method as well, and
      // these are real vendor endpoints that delete or edit a model.
      ['DELETE', '/v1/models/meta/musicgen'],
      ['PATCH', '/v1/models/meta/musicgen'],
      ['DELETE', '/v1/predictions/abc-123'],
    ] as const

    for (const [method, path] of denied) {
      fetchMock.mockClear()
      const res = await req(path, { method })
      expect(res.status, `${method} ${path}`).toBe(403)
      const body = await res.json()
      expect(body.error).toBeTruthy()
      expect(body.allowed).toEqual(expect.arrayContaining(['GET /catalog']))
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })

  it('canonicalization misses do not forward', async () => {
    const fetchMock = mockVendorFetch(() => new Response('{}', { status: 200 }))
    for (const path of [
      // URL parsing collapses dot segments before the route sees the path; whatever
      // survives that must still miss the op table.
      '/v1/models/a/../../account', // -> /v1/account
      '/v1/models/./.', // -> /v1/models/ — the public model list, off-table
      '/v1/models/%2e%2e/account',
      '/v1/models/foo%2Fbar/baz', // encoded slash survives; the owner/name class rejects %
    ]) {
      fetchMock.mockClear()
      const res = await req(path)
      expect(res.status, path).toBe(403)
      expect(fetchMock, path).not.toHaveBeenCalled()
    }
  })
})

describe('official create whitelist', () => {
  it('403 for off-list model', async () => {
    const fetchMock = mockVendorFetch(() => new Response('{}', { status: 200 }))
    const res = await req('/v1/models/acme/evil/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: {} }),
    })
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards on-list model', async () => {
    const fetchMock = mockVendorFetch(
      () => new Response('{"id":"1"}', { status: 201, headers: { 'content-type': 'application/json' } }),
    )
    const res = await req('/v1/models/meta/musicgen/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { prompt: 'x' } }),
    })
    expect(res.status).toBe(201)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toBe('https://api.replicate.com/v1/models/meta/musicgen/predictions')
  })
})

describe('community create', () => {
  it('403 bare-hash with remedy', async () => {
    const fetchMock = mockVendorFetch(() => new Response('{}', { status: 200 }))
    const res = await req('/v1/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: HASH, input: {} }),
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.remedy).toMatch(/owner\/name:version/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('403 off-list qualified version without verifier call', async () => {
    const fetchMock = mockVendorFetch(() => new Response('{}', { status: 200 }))
    const res = await req('/v1/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: `acme/evil:${HASH}`, input: {} }),
    })
    expect(res.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards when verifier returns 200', async () => {
    const fetchMock = mockVendorFetch(async (input) => {
      const url = String(input)
      if (url.includes('/versions/')) {
        return new Response('{}', { status: 200 })
      }
      return new Response('{"id":"p1"}', { status: 201, headers: { 'content-type': 'application/json' } })
    })
    const res = await req('/v1/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: QUALIFIED, input: { prompt: 'hi' } }),
    })
    expect(res.status).toBe(201)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The verifier must read the model the whitelist just approved — verifying against
    // any other model would make the check decorative.
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://api.replicate.com/v1/models/meta/musicgen/versions/${HASH}`,
    )
  })

  it('403 when verifier returns 404', async () => {
    const fetchMock = mockVendorFetch(async (input) => {
      if (String(input).includes('/versions/')) return new Response('{}', { status: 404 })
      return new Response('{}', { status: 201 })
    })
    const res = await req('/v1/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: QUALIFIED, input: {} }),
    })
    expect(res.status).toBe(403)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('502 when verifier returns 500', async () => {
    mockVendorFetch(async (input) => {
      if (String(input).includes('/versions/')) return new Response('{}', { status: 500 })
      return new Response('{}', { status: 201 })
    })
    const res = await req('/v1/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: QUALIFIED, input: {} }),
    })
    expect(res.status).toBe(502)
  })
})

describe('outbound request policy', () => {
  // Both create forms, because the policy is what stops an agent-supplied callback URL
  // and an agent-supplied cancel deadline from reaching the vendor. A single-form test
  // leaves the other path free to regress.
  const createForms = [
    ['official', '/v1/models/meta/musicgen/predictions', { input: { prompt: 'keep-me' } }],
    ['community', '/v1/predictions', { version: QUALIFIED, input: { prompt: 'keep-me' } }],
  ] as const

  it.each(createForms)(
    '%s create: key swapped in, Cancel-After forced, headers allowlisted, webhook stripped',
    async (_form, path, body) => {
      const fetchMock = mockVendorFetch(async (input) => {
        if (String(input).includes('/versions/')) return new Response('{}', { status: 200 })
        return new Response('{"id":"p1"}', { status: 201, headers: { 'content-type': 'application/json' } })
      })

      await req(path, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer synth_x',
          'Content-Type': 'application/json',
          'Cancel-After': '9999',
          'X-Custom': 'y',
          Prefer: 'wait=55',
        },
        body: JSON.stringify({
          ...body,
          webhook: 'https://evil.example',
          webhook_events_filter: ['completed'],
        }),
      })

      const createCall = fetchMock.mock.calls.find((call) => !String(call[0]).includes('/versions/'))
      expect(createCall).toBeTruthy()
      const init = createCall![1] as RequestInit
      const headers = init.headers as Record<string, string>
      // Exact key set: proves the agent's own bearer cannot ride along under any header
      // name, which asserting on one custom header does not.
      expect(Object.keys(headers).sort()).toEqual([
        'Authorization',
        'Cancel-After',
        'Content-Type',
        'Prefer',
      ])
      expect(headers.Authorization).toBe(`Bearer ${REAL_KEY}`)
      expect(headers['Cancel-After']).toBe('600')
      expect(headers.Prefer).toBe('wait=55')
      // Webhook fields gone, everything else byte-for-byte what the agent sent.
      expect(JSON.parse(String(init.body))).toEqual(body)
    },
  )
})

describe('response relay', () => {
  it('relays vendor 402 JSON byte-identical', async () => {
    const payload = '{"detail":"Insufficient credit"}'
    mockVendorFetch(
      () =>
        new Response(payload, {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const res = await req('/v1/models/meta/musicgen')
    expect(res.status).toBe(402)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.text()).toBe(payload)
  })

  it('relays vendor non-JSON error body', async () => {
    mockVendorFetch(() => new Response('plain fail', { status: 502, headers: { 'content-type': 'text/plain' } }))
    const res = await req('/v1/models/meta/musicgen')
    expect(res.status).toBe(502)
    expect(await res.text()).toBe('plain fail')
  })

  // The skill branches on this pair: a lane refusal means "you asked for something not
  // allowed", a vendor error means "Replicate said no". Both can be 403, so proving one
  // side alone proves nothing about telling them apart.
  it('lane refusals carry the allow table; vendor errors relay unchanged', async () => {
    const laneRefusal = await req('/v1/account')
    expect(laneRefusal.status).toBe(403)
    expect(await laneRefusal.json()).toEqual(
      expect.objectContaining({ error: expect.any(String), allowed: expect.any(Array) }),
    )

    mockVendorFetch(
      () =>
        new Response('{"detail":"Forbidden"}', {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const vendorError = await req('/v1/models/meta/musicgen')
    expect(vendorError.status).toBe(403)
    expect(await vendorError.json()).toEqual({ detail: 'Forbidden' })
  })

  it('502 with a retry remedy when the vendor is unreachable', async () => {
    mockVendorFetch(() => {
      throw new TypeError('fetch failed')
    })
    const res = await req('/v1/models/meta/musicgen')
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/unreachable/i)
    expect(body.remedy).toBeTruthy()
  })
})

describe('create body gates', () => {
  it('415 on Content-Encoding', async () => {
    const fetchMock = mockVendorFetch(() => new Response('{}', { status: 201 }))
    const res = await req('/v1/models/meta/musicgen/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: JSON.stringify({ input: {} }),
    })
    expect(res.status).toBe(415)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('413 when body exceeds cap', async () => {
    const fetchMock = mockVendorFetch(() => new Response('{}', { status: 201 }))
    const huge = 'x'.repeat(10_000_001)
    const res = await req('/v1/models/meta/musicgen/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"input":{"d":"${huge}"}}`,
    })
    expect(res.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400 when the create body is not declared JSON', async () => {
    const fetchMock = mockVendorFetch(() => new Response('{}', { status: 201 }))
    const res = await req('/v1/models/meta/musicgen/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'input=x',
    })
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('413 on an oversized declared length without buffering the body', async () => {
    const fetchMock = mockVendorFetch(() => new Response('{}', { status: 201 }))
    const res = await req('/v1/models/meta/musicgen/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '20000000' },
      body: JSON.stringify({ input: {} }),
    })
    expect(res.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400 on non-JSON create body', async () => {
    const fetchMock = mockVendorFetch(() => new Response('{}', { status: 201 }))
    const res = await req('/v1/models/meta/musicgen/predictions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
