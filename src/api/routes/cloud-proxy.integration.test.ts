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

/**
 * Open a request and keep the socket, for the responses that are not supposed to
 * end: `sendRaw` resolves on `end`, which for a stream means never.
 */
function openRaw(lines: string[]) {
  const head = [...lines, `Host: 127.0.0.1:${port}`, '', ''].join('\r\n')
  const socket = net.connect(port, '127.0.0.1', () => socket.write(head))
  let received = ''
  const waiters = new Set<() => void>()
  socket.on('data', (chunk) => {
    received += chunk.toString()
    for (const waiter of [...waiters]) waiter()
  })
  socket.on('error', () => {})
  return {
    get received() {
      return received
    },
    waitFor(needle: string, timeoutMs = 5_000): Promise<void> {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!received.includes(needle)) return
          cleanup()
          resolve()
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(received.slice(0, 400))}`))
        }, timeoutMs)
        const cleanup = () => {
          clearTimeout(timer)
          waiters.delete(check)
        }
        waiters.add(check)
        check()
      })
    },
    disconnect: () => socket.destroy(),
  }
}

/** An upstream response whose body this test pushes to by hand. */
function streamingUpstream(init?: ResponseInit) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c
    },
    cancel: () => {
      cancelled = true
    },
  })
  return {
    response: new Response(stream, init),
    push: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    close: () => controller.close(),
    get cancelled() {
      return cancelled
    },
  }
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

  it('preserves percent-encoding and query across the wire', async () => {
    await sendRaw([`GET ${path('/api/agents/a%2Fb/files?path=x%20y&n=1')} HTTP/1.1`])

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://workspace.example.com/api/agents/a%2Fb/files?path=x%20y&n=1',
    )
  })

  it('passes a range response through with its content-range intact', async () => {
    // `<img src>` and the file preview seek; a 206 rewritten to 200, or stripped
    // of content-range, restarts the transfer instead of continuing it.
    mockFetch.mockResolvedValueOnce(
      new Response('partial', {
        status: 206,
        headers: { 'content-range': 'bytes 0-6/100', 'content-type': 'application/octet-stream' },
      }),
    )

    const response = await sendRaw([
      `GET ${path('/api/agents/x/files/big.bin')} HTTP/1.1`,
      'Range: bytes=0-6',
    ])

    expect(response).toContain('HTTP/1.1 206')
    expect(response.toLowerCase()).toContain('content-range: bytes 0-6/100')
    expect(mockFetch.mock.calls[0][1].headers.get('range')).toBe('bytes=0-6')
  })
})

/**
 * Streaming, over a socket that stays open.
 *
 * These are the cases `app.request()` cannot reach at all. An SSE response is
 * only useful if each event leaves the proxy as it arrives, and the proxy only
 * stops costing the deployment a connection if a renderer that navigated away
 * propagates its cancellation upstream. Both are properties of the transport,
 * and both look identical to a buffered, leaking implementation until something
 * holds a real socket open and watches the timing.
 */
describe('cloud proxy streaming over a real socket', () => {
  it('delivers each SSE event as it arrives, not at the end', async () => {
    const upstream = streamingUpstream({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    mockFetch.mockResolvedValueOnce(upstream.response)

    const client = openRaw([`GET ${path('/api/notifications/stream')} HTTP/1.1`, 'Accept: text/event-stream'])

    upstream.push('data: one\n\n')
    await client.waitFor('data: one')

    // The decisive part: the upstream is still open. A proxy that buffered would
    // have sent nothing yet.
    upstream.push('data: two\n\n')
    await client.waitFor('data: two')

    upstream.close()
    client.disconnect()
  })

  it('aborts the upstream request when the renderer disconnects', async () => {
    const upstream = streamingUpstream({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    mockFetch.mockResolvedValueOnce(upstream.response)

    const client = openRaw([`GET ${path('/api/notifications/stream')} HTTP/1.1`])
    upstream.push('data: hello\n\n')
    await client.waitFor('data: hello')

    const signal = (mockFetch.mock.calls[0][1] as { signal: AbortSignal }).signal
    expect(signal.aborted).toBe(false)

    client.disconnect()

    // Without this the deployment keeps generating events for a window that is
    // gone, and the connection is held until it times out on their side.
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 5_000 })
  })

  it('streams an over-limit upload instead of buffering it for a replay', async () => {
    const size = 2.5 * 1024 * 1024
    mockFetch.mockResolvedValueOnce(new Response('expired', { status: 401 }))
    mockRefreshTarget.mockResolvedValue({ ...TARGET, token: 'fresh-token' })

    const client = openRaw([
      `POST ${path('/api/agents/x/files')} HTTP/1.1`,
      'Content-Type: application/octet-stream',
      `Content-Length: ${size}`,
    ])
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1), { timeout: 5_000 })

    // Handed upstream as a live stream: buffering 2.5MB to buy one retry is the
    // wrong trade, so this request forgoes the replay the small ones get.
    expect((mockFetch.mock.calls[0][1] as { body: unknown }).body).toBeInstanceOf(ReadableStream)
    await vi.waitFor(() => expect(mockRefreshTarget).toHaveBeenCalledTimes(1), { timeout: 5_000 })
    expect(mockFetch).toHaveBeenCalledTimes(1)

    client.disconnect()
  })
})
