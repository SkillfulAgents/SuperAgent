import { createServer } from 'node:http'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as dnsPromises from 'node:dns/promises'

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return {
    ...actual,
    lookup: vi.fn(),
  }
})

import { mcpSafeFetch } from './mcp-safe-fetch'

const lookupMock = dnsPromises.lookup as unknown as ReturnType<typeof vi.fn>

describe('mcpSafeFetch', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.E2E_MOCK
    lookupMock.mockResolvedValue({ address: '93.184.216.34', family: 4 })
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('follows a public redirect and strips Authorization cross-origin', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://cdn.example/mcp' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const res = await mcpSafeFetch('https://public.example/mcp', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(mockFetch.mock.calls[1][0]).toBe('https://cdn.example/mcp')
    const secondHeaders = new Headers(
      (mockFetch.mock.calls[1][1] as RequestInit).headers,
    )
    expect(secondHeaders.get('authorization')).toBeNull()
  })

  it('refuses a redirect Location that resolves to a private IP', async () => {
    mockFetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://metadata.example/' },
      }),
    )
    lookupMock
      .mockResolvedValueOnce({ address: '93.184.216.34', family: 4 })
      .mockResolvedValueOnce({ address: '169.254.169.254', family: 4 })

    await expect(mcpSafeFetch('https://public.example/mcp')).rejects.toThrow(
      /private or loopback/i,
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('does not replay a 307 body across origins', async () => {
    mockFetch.mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { Location: 'https://cdn.example/token' },
      }),
    )

    const res = await mcpSafeFetch('https://public.example/token', {
      method: 'POST',
      body: 'client_secret=s3cret',
    })
    expect(res.status).toBe(307)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('mcpSafeFetch pin (live connect)', () => {
  let originalE2EMock: string | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    originalE2EMock = process.env.E2E_MOCK
    process.env.E2E_MOCK = '1'
    lookupMock.mockResolvedValue({ address: '127.0.0.1', family: 4 })
  })

  afterEach(() => {
    if (originalE2EMock === undefined) delete process.env.E2E_MOCK
    else process.env.E2E_MOCK = originalE2EMock
  })

  it('connects when undici lookup returns the pinned address list', async () => {
    const server = createServer((req, res) => {
      res.end(`host=${req.headers.host}`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }

    try {
      const res = await mcpSafeFetch(`http://localhost:${port}/mcp`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(`host=localhost:${port}`)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    }
  })
})
