import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import net from 'node:net'
import type { AddressInfo } from 'node:net'

/**
 * The cloud proxy over a real HTTP listener.
 *
 * `app.request()` builds a `Request` in-process, and the production path does
 * not: `@hono/node-server` gives every non-GET/HEAD request a `ReadableStream`
 * body whether or not any bytes follow. A bodyless `DELETE` therefore looks
 * body-bearing to the Fetch API and body-less to the HTTP framing, and only
 * this transport can tell the two apart. Requests are written as raw bytes so
 * the framing under test is the framing on the wire, not whatever a client
 * library decides to add.
 */

// Deliberately NOT mocking @hono/node-server/conninfo — over a real socket the
// loopback check is exercised for real.
const mockResolveTarget = vi.fn()
const mockRefreshTarget = vi.fn()
vi.mock('@shared/lib/services/cloud-proxy-target', () => ({
  resolveCloudProxyTarget: () => mockResolveTarget(),
  refreshCloudProxyTarget: () => mockRefreshTarget(),
}))

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import cloudProxy, { CLOUD_PROXY_PREFIX } from './cloud-proxy'
import { getCloudProxyKey } from '@shared/lib/services/cloud-proxy-key'

const TARGET = { deploymentUrl: 'https://workspace.example.com', token: 'deployment-token' }

let server: ReturnType<typeof serve>
let port: number

beforeAll(async () => {
  const app = new Hono()
  app.route(CLOUD_PROXY_PREFIX, cloudProxy)
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      port = info.port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockReset()
  mockFetch.mockImplementation(async () => new Response('{}', { status: 200 }))
  mockResolveTarget.mockReturnValue(TARGET)
  mockRefreshTarget.mockResolvedValue(null)
})

/** Write an exact request onto the wire and read the whole response back. */
function sendRaw(lines: string[], body = ''): Promise<string> {
  const head = [...lines, `Host: 127.0.0.1:${port}`, 'Connection: close', '', ''].join('\r\n')
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(head + body))
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk.toString()
    })
    socket.on('end', () => resolve(received))
    socket.on('error', reject)
  })
}

function path(suffix: string): string {
  return `${CLOUD_PROXY_PREFIX}/${getCloudProxyKey()}${suffix}`
}

describe('cloud proxy over a real listener', () => {
  it('forwards a plain GET', async () => {
    const response = await sendRaw([`GET ${path('/api/agents')} HTTP/1.1`])
    expect(response).toContain('HTTP/1.1 200')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['DELETE', '/api/agents/x'],
    ['POST', '/api/agents/x/interrupt'],
    ['PATCH', '/api/notifications/1'],
  ])(
    'retries a bodyless %s that declares no framing at all',
    async (method, suffix) => {
      // The Fetch body property says "stream" here; the framing says "no body".
      // Trusting the former is what left these unreplayable.
      mockFetch
        .mockResolvedValueOnce(new Response('expired', { status: 401 }))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
      mockRefreshTarget.mockResolvedValue({ ...TARGET, token: 'fresh-token' })

      const response = await sendRaw([`${method} ${path(suffix)} HTTP/1.1`])

      expect(response).toContain('HTTP/1.1 200')
      expect(mockFetch).toHaveBeenCalledTimes(2)
      const retried = mockFetch.mock.calls[1][1] as { headers: Headers; body: unknown }
      expect(retried.headers.get('authorization')).toBe('Bearer fresh-token')
      expect(retried.body).toBeNull()
    },
  )

  it('retries a bodyless DELETE that declares Content-Length: 0', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    mockRefreshTarget.mockResolvedValue({ ...TARGET, token: 'fresh-token' })

    const response = await sendRaw([`DELETE ${path('/api/agents/x')} HTTP/1.1`, 'Content-Length: 0'])

    expect(response).toContain('HTTP/1.1 200')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('replays a declared body verbatim', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    mockRefreshTarget.mockResolvedValue({ ...TARGET, token: 'fresh-token' })

    const payload = '{"name":"a"}'
    await sendRaw(
      [
        `POST ${path('/api/agents')} HTTP/1.1`,
        'Content-Type: application/json',
        `Content-Length: ${payload.length}`,
      ],
      payload,
    )

    expect(mockFetch).toHaveBeenCalledTimes(2)
    const replayed = (mockFetch.mock.calls[1][1] as { body: ArrayBuffer }).body
    expect(new TextDecoder().decode(replayed)).toBe(payload)
  })

  it('streams a chunked body and does not replay it', async () => {
    mockFetch.mockImplementation(async () => new Response('expired', { status: 401 }))
    mockRefreshTarget.mockResolvedValue({ ...TARGET, token: 'fresh-token' })

    const response = await sendRaw(
      [`POST ${path('/api/agents/x/files')} HTTP/1.1`, 'Transfer-Encoding: chunked'],
      '7\r\npayload\r\n0\r\n\r\n',
    )

    expect(response).toContain('HTTP/1.1 401')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockRefreshTarget).toHaveBeenCalledTimes(1)
  })

  it('rejects a bad key without reaching the deployment', async () => {
    const response = await sendRaw([`GET ${CLOUD_PROXY_PREFIX}/wrong-key/api/agents HTTP/1.1`])
    expect(response).toContain('HTTP/1.1 404')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
