import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { WebSocket, WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { createServer, type Server } from 'node:http'

/**
 * The WebSocket half of the cloud proxy, end to end: a real client, a real
 * listener running the upgrade handler, and a real upstream WebSocket server
 * standing in for the deployment.
 *
 * There is no synthetic alternative here — an upgrade never reaches Hono, so
 * `app.request()` cannot express this test at all.
 */

const mockResolveTarget = vi.fn()
const mockRefreshTarget = vi.fn()
vi.mock('@shared/lib/services/cloud-proxy-target', () => ({
  resolveCloudProxyTarget: () => mockResolveTarget(),
  refreshCloudProxyTarget: () => mockRefreshTarget(),
}))

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn() }))

import { setupCloudStreamProxy } from './cloud-stream-proxy'
import { CLOUD_PROXY_PREFIX } from '../api/routes/cloud-proxy'
import { getCloudProxyKey } from '@shared/lib/services/cloud-proxy-key'

const originalProcessType = (process as { type?: string }).type

let localServer: ReturnType<typeof serve>
let localPort: number

/**
 * The stand-in deployment. It owns its own upgrade handling rather than letting
 * `ws` bind a server, because the status of a *rejected* handshake is the thing
 * under test and ws's own rejection paths answer 400.
 */
let upstreamHttp: Server
let upstream: WebSocketServer
let upstreamPort: number
/** Handshakes the upstream saw, in order — including the rejected ones. */
let handshakes: { authorization?: string; url?: string }[]
/** How many more handshakes the upstream should reject with 401. */
let rejectWith401 = 0

beforeAll(async () => {
  ;(process as { type?: string }).type = 'browser'

  upstream = new WebSocketServer({ noServer: true })
  upstream.on('connection', (socket: WebSocket) => {
    socket.on('message', (data, isBinary) => {
      // Echo, so framing survives a round trip and can be asserted on.
      socket.send(data, { binary: isBinary })
    })
  })

  upstreamHttp = createServer()
  upstreamHttp.on('upgrade', (request, socket, head) => {
    handshakes.push({ authorization: request.headers.authorization, url: request.url })
    if (rejectWith401 > 0) {
      rejectWith401 -= 1
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    upstream.handleUpgrade(request, socket, head, (client) => {
      upstream.emit('connection', client, request)
    })
  })
  await new Promise<void>((resolve) => {
    upstreamHttp.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstreamHttp.address() as AddressInfo).port
      resolve()
    })
  })

  const app = new Hono()
  await new Promise<void>((resolve) => {
    localServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      localPort = info.port
      resolve()
    })
  })
  setupCloudStreamProxy(localServer)
})

afterAll(async () => {
  if (originalProcessType === undefined) delete (process as { type?: string }).type
  else (process as { type?: string }).type = originalProcessType
  // An upgraded socket is handed to the upgrade listener and stops being one of
  // the server's tracked connections, so neither closeAllConnections() nor
  // close()'s callback accounts for it — awaiting close() here waits forever.
  // Tear the sockets down by hand and let the listeners close in the background.
  for (const socket of upstream.clients) socket.terminate()
  upstream.close()
  // ServerType is a union that includes Http2Server, which has no such method.
  ;(localServer as Partial<Server>).closeAllConnections?.()
  upstreamHttp.closeAllConnections()
  localServer.close()
  upstreamHttp.close()
})

beforeEach(() => {
  vi.clearAllMocks()
  handshakes = []
  rejectWith401 = 0
  mockResolveTarget.mockReturnValue({
    deploymentUrl: `http://127.0.0.1:${upstreamPort}`,
    token: 'deployment-token',
  })
  mockRefreshTarget.mockResolvedValue(null)
})

const openSockets: WebSocket[] = []

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.terminate()
})

function connect(path: string): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${localPort}${path}`)
  openSockets.push(socket)
  return socket
}

function keyed(suffix: string): string {
  return `${CLOUD_PROXY_PREFIX}/${getCloudProxyKey()}${suffix}`
}

/** Resolve on open, reject with the handshake status or error otherwise. */
function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)))
    socket.once('error', reject)
  })
}

const STREAM_PATH = '/api/agents/my-agent/browser/stream'

describe('cloud stream proxy', () => {
  it('bridges a client to the deployment, presenting the bearer', async () => {
    const client = connect(keyed(STREAM_PATH))
    await opened(client)

    expect(handshakes).toHaveLength(1)
    expect(handshakes[0].authorization).toBe('Bearer deployment-token')
    expect(handshakes[0].url).toBe(STREAM_PATH)
  })

  it('carries the query string through', async () => {
    const client = connect(keyed(`${STREAM_PATH}?quality=low`))
    await opened(client)

    expect(handshakes[0].url).toBe(`${STREAM_PATH}?quality=low`)
  })

  it('relays text frames as text', async () => {
    const client = connect(keyed(STREAM_PATH))
    await opened(client)

    const echoed = new Promise<{ data: unknown; binary: boolean }>((resolve) => {
      client.once('message', (data, isBinary) => resolve({ data, binary: isBinary }))
    })
    client.send(JSON.stringify({ type: 'click', x: 1 }))
    const received = await echoed

    expect(received.binary).toBe(false)
    expect(String(received.data)).toBe('{"type":"click","x":1}')
  })

  it('relays binary frames as binary, which is how every video frame arrives', async () => {
    const client = connect(keyed(STREAM_PATH))
    await opened(client)

    const echoed = new Promise<{ data: unknown; binary: boolean }>((resolve) => {
      client.once('message', (data, isBinary) => resolve({ data, binary: isBinary }))
    })
    client.send(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const received = await echoed

    expect(received.binary).toBe(true)
    expect(Buffer.from(received.data as Buffer)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('closes the client when the deployment closes', async () => {
    const client = connect(keyed(STREAM_PATH))
    await opened(client)

    const closed = new Promise<number>((resolve) => client.once('close', resolve))
    for (const socket of upstream.clients) socket.close(1000, 'done')

    await expect(closed).resolves.toBeGreaterThan(0)
  })

  it('re-mints once and reconnects when the deployment rejects the token', async () => {
    rejectWith401 = 1
    mockRefreshTarget.mockResolvedValue({
      deploymentUrl: `http://127.0.0.1:${upstreamPort}`,
      token: 'fresh-token',
    })

    const client = connect(keyed(STREAM_PATH))
    await opened(client)

    // The browser never saw the failure: it was still waiting on its handshake.
    expect(mockRefreshTarget).toHaveBeenCalledTimes(1)
    expect(handshakes.map((h) => h.authorization)).toEqual([
      'Bearer deployment-token',
      'Bearer fresh-token',
    ])
  })

  it('gives up after one re-mint rather than looping', async () => {
    rejectWith401 = 2
    mockRefreshTarget.mockResolvedValue({
      deploymentUrl: `http://127.0.0.1:${upstreamPort}`,
      token: 'fresh-token',
    })

    const client = connect(keyed(STREAM_PATH))

    await expect(opened(client)).rejects.toThrow(/502/)
    expect(mockRefreshTarget).toHaveBeenCalledTimes(1)
    expect(handshakes).toHaveLength(2)
  })

  it('does not reconnect when no fresh token can be obtained', async () => {
    rejectWith401 = 1
    mockRefreshTarget.mockResolvedValue(null)

    const client = connect(keyed(STREAM_PATH))

    await expect(opened(client)).rejects.toThrow(/502/)
    expect(handshakes).toHaveLength(1)
  })

  it('refuses a bad key without touching the deployment', async () => {
    const client = connect(`${CLOUD_PROXY_PREFIX}/wrong-key${STREAM_PATH}`)

    await expect(opened(client)).rejects.toThrow(/404/)
    expect(handshakes).toHaveLength(0)
  })

  it('refuses a path outside /api', async () => {
    const client = connect(keyed('/internal/socket'))

    await expect(opened(client)).rejects.toThrow(/404/)
    expect(handshakes).toHaveLength(0)
  })

  it('refuses a request carrying a real website Origin', async () => {
    const client = new WebSocket(`ws://127.0.0.1:${localPort}${keyed(STREAM_PATH)}`, {
      origin: 'https://evil.example',
    })
    openSockets.push(client)

    await expect(opened(client)).rejects.toThrow(/403/)
    expect(handshakes).toHaveLength(0)
  })

  it('reports a workspace with no token as a gateway failure', async () => {
    mockResolveTarget.mockReturnValue(null)

    const client = connect(keyed(STREAM_PATH))

    await expect(opened(client)).rejects.toThrow(/502/)
    expect(handshakes).toHaveLength(0)
  })

  it('leaves upgrades outside its prefix for other handlers', async () => {
    // The browser-stream proxy owns this path locally; if the cloud proxy
    // answered it, local browser streaming would break the moment this shipped.
    const client = connect(STREAM_PATH)

    // Nothing is listening for it in this test, so it hangs rather than being
    // answered — the point is that it is not answered *here*.
    const outcome = await Promise.race([
      opened(client).then(() => 'opened').catch((e: Error) => e.message),
      new Promise<string>((resolve) => setTimeout(() => resolve('unanswered'), 250)),
    ])

    expect(outcome).toBe('unanswered')
    expect(handshakes).toHaveLength(0)
  })
})
