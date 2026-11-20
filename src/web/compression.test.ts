import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { isRelayedPath, mountCompression } from './compression'
import { mountWebBuild } from './web-build'

// Everything here goes through a real socket with a raw client: `fetch` sends
// its own Accept-Encoding and decodes what comes back, so it can show neither
// the bytes on the wire nor when each of them arrived.

interface WireResponse {
  status: number
  headers: IncomingHttpHeaders
  /** The body exactly as sent, still encoded if it was. */
  body: Buffer
}

function decoded(res: WireResponse): Buffer {
  return res.headers['content-encoding'] === 'gzip' ? gunzipSync(res.body) : res.body
}

/** A promise settled from outside, so a test decides when a handler goes on. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const LARGE = { models: Array.from({ length: 400 }, (_, i) => ({ id: `provider/model-${i}`, name: `Model ${i}`, contextWindow: 200000, supportsTools: true })) }
const LARGE_JSON = JSON.stringify(LARGE)
const ASSET_JS = `export const table = ${JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ key: `entry-${i}`, label: `Label ${i}` })))}`
const ICON_PNG = randomBytes(8 * 1024)
const BROWSER = 'gzip, deflate, br, zstd'

describe('gzip on the Node web server', () => {
  let root: string
  let port: number
  let server: ReturnType<typeof createServer>

  // What the stream handlers wait on. Each test that uses one replaces it.
  let sseGate = gate()
  let relayGate = gate()

  function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<WireResponse> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
  }

  /** Open a response and hand it over as soon as its headers are in, body unread. */
  function open(path: string, headers: Record<string, string> = {}): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers }, resolve)
      req.on('error', reject)
      req.end()
    })
  }

  function nextChunk(res: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      res.once('data', (chunk: Buffer) => resolve(chunk.toString('utf-8')))
      res.once('error', reject)
      res.once('end', () => reject(new Error('the response ended before another chunk arrived')))
    })
  }

  /** A body under a compressible type that sends one piece, then waits on the test. */
  function relayed(): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(`{"first":"${'y'.repeat(4096)}",`))
        await relayGate.promise
        controller.enqueue(encoder.encode('"second":true}'))
        controller.close()
      },
    })
    return new Response(body, { headers: { 'Content-Type': 'application/json' } })
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'superagent-compression-'))
    await mkdir(join(root, 'assets'))
    await Promise.all([
      writeFile(join(root, 'index.html'), `<!doctype html><html><head><title>App</title></head><body>${'<p>shell</p>'.repeat(300)}</body></html>`),
      writeFile(join(root, 'assets', 'index-abc123.js'), ASSET_JS),
      writeFile(join(root, 'assets', 'tiny-abc123.js'), 'export default 1'),
      writeFile(join(root, 'assets', 'icon-abc123.png'), ICON_PNG),
    ])

    const app = new Hono()
    mountCompression(app)

    app.get('/api/large', (c) => c.json(LARGE))
    app.get('/api/missing', (c) => {
      c.header('Set-Cookie', 'a=1; Path=/', { append: true })
      c.header('Set-Cookie', 'b=2; Path=/', { append: true })
      c.header('Cache-Control', 'private, no-store')
      return c.json({ error: 'Not found', detail: LARGE }, 404)
    })
    app.get('/api/already-encoded', (c) => {
      c.header('Content-Encoding', 'br')
      c.header('Content-Type', 'application/json')
      return c.body(new Uint8Array(randomBytes(4096)))
    })
    // A body written in pieces that ends on its own, like a streamed message page.
    app.get('/api/agents/a/sessions/s/messages', () => {
      const encoder = new TextEncoder()
      const pieces = LARGE_JSON.match(/.{1,1000}/gs) ?? []
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const piece = pieces.shift()
          if (piece === undefined) controller.close()
          else controller.enqueue(encoder.encode(piece))
        },
      })
      return new Response(body, { headers: { 'Content-Type': 'application/json' } })
    })
    // The session and notification streams: one event, then nothing until the test says so.
    app.get('/api/notifications/stream', (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: 'first', data: 'x'.repeat(4096) })
        await sseGate.promise
        await stream.writeSSE({ event: 'second', data: 'done' })
      }),
    )
    // What an agent container calls, and a dashboard's own server.
    app.post('/api/proxy/a/anthropic/v1/messages', relayed)
    app.get('/api/mcp-proxy/a/server', relayed)
    app.get('/api/agents/a/artifacts/board/api/feed', relayed)

    mountWebBuild(app, root)
    server = createServer(getRequestListener(app.fetch))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    try {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        })
      }
    } finally {
      if (root) await rm(root, { recursive: true, force: true })
    }
  })

  it('sends a large JSON response gzipped, at a fraction of the bytes', async () => {
    const identity = await get('/api/large')
    const res = await get('/api/large', { 'Accept-Encoding': BROWSER })

    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers['content-type']).toBe('application/json')
    expect(res.headers['vary']).toBe('Accept-Encoding')
    expect(decoded(res).toString('utf-8')).toBe(LARGE_JSON)
    // The point of the middleware: a regression that stops encoding fails here.
    expect(identity.body.byteLength).toBe(Buffer.byteLength(LARGE_JSON))
    expect(res.body.byteLength).toBeLessThan(identity.body.byteLength / 4)
  })

  it.each([
    ['no Accept-Encoding', {}],
    ['identity only', { 'Accept-Encoding': 'identity' }],
    ['gzip and deflate refused', { 'Accept-Encoding': 'gzip;q=0, deflate;q=0' }],
    ['only codings this server does not produce', { 'Accept-Encoding': 'br, zstd' }],
  ] as Array<[string, Record<string, string>]>)('sends the body as it is with %s, and says the answer varies', async (_name, headers) => {
    const res = await get('/api/large', headers)

    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.headers['vary']).toBe('Accept-Encoding')
    expect(res.body.toString('utf-8')).toBe(LARGE_JSON)
  })

  it('keeps the status and the other headers of a response it encodes', async () => {
    const res = await get('/api/missing', { 'Accept-Encoding': BROWSER })

    expect(res.status).toBe(404)
    expect(res.headers['content-encoding']).toBe('gzip')
    expect(res.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/'])
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(JSON.parse(decoded(res).toString('utf-8')).error).toBe('Not found')
  })

  it('encodes a body written in pieces that ends on its own', async () => {
    const res = await get('/api/agents/a/sessions/s/messages', { 'Accept-Encoding': BROWSER })

    expect(res.headers['content-encoding']).toBe('gzip')
    expect(decoded(res).toString('utf-8')).toBe(LARGE_JSON)
  })

  it('answers HEAD without a body and without encoding', async () => {
    const res = await get('/api/large', { 'Accept-Encoding': BROWSER }, 'HEAD')

    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(res.body.byteLength).toBe(0)
  })

  it('leaves a body that is already encoded alone', async () => {
    const res = await get('/api/already-encoded', { 'Accept-Encoding': BROWSER })

    expect(res.headers['content-encoding']).toBe('br')
    expect(res.body.byteLength).toBe(4096)
  })

  describe('live streams', () => {
    it('delivers an SSE event at once, with the stream still open behind it', async () => {
      sseGate = gate()
      const res = await open('/api/notifications/stream', { 'Accept-Encoding': BROWSER, Accept: 'text/event-stream' })

      expect(res.headers['content-type']).toContain('text/event-stream')
      expect(res.headers['content-encoding']).toBeUndefined()
      // The handler is parked on the gate, so the stream cannot have ended:
      // this resolves only if the first event left the server without waiting
      // for the rest. A compressor holding it back hangs here.
      const first = await nextChunk(res)
      expect(first).toContain('event: first')
      expect(first).not.toContain('event: second')

      const second = nextChunk(res)
      sseGate.open()
      expect(await second).toContain('event: second')
    })

    // The same handler on a path inside the middleware would hang at the first
    // chunk: a CompressionStream gives out a gzip header and then nothing until
    // it has a block's worth or the body ends.
    it.each([
      ['an agent container’s LLM/API proxy call', '/api/proxy/a/anthropic/v1/messages', 'POST'],
      ['an agent container’s MCP proxy call', '/api/mcp-proxy/a/server', 'GET'],
      ['a dashboard’s own server', '/api/agents/a/artifacts/board/api/feed', 'GET'],
    ])('passes %s through chunk by chunk, unencoded, whatever its type', async (_name, path, method) => {
      relayGate = gate()
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Accept-Encoding': BROWSER } }, resolve)
        req.on('error', reject)
        req.end()
      })

      expect(res.headers['content-type']).toBe('application/json')
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.headers['vary']).toBeUndefined()
      const first = await nextChunk(res)
      expect(first.startsWith('{"first":"yyyy')).toBe(true)

      let rest = ''
      const ended = new Promise<void>((resolve) => {
        res.on('data', (chunk: Buffer) => (rest += chunk.toString('utf-8')))
        res.on('end', resolve)
      })
      relayGate.open()
      await ended
      expect(JSON.parse(first + rest)).toEqual({ first: 'y'.repeat(4096), second: true })
    })
  })

  describe('the web build', () => {
    it('encodes a hashed script and keeps its permanent caching', async () => {
      const identity = await get('/assets/index-abc123.js')
      const res = await get('/assets/index-abc123.js', { 'Accept-Encoding': BROWSER })

      expect(identity.headers['content-encoding']).toBeUndefined()
      expect(identity.headers['vary']).toBe('Accept-Encoding')
      expect(Number(identity.headers['content-length'])).toBe(Buffer.byteLength(ASSET_JS))
      expect(identity.body.toString('utf-8')).toBe(ASSET_JS)

      expect(res.status).toBe(200)
      expect(res.headers['content-encoding']).toBe('gzip')
      expect(res.headers['vary']).toBe('Accept-Encoding')
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(res.headers['content-type']).toContain('javascript')
      // The identity length must not survive onto the encoded body.
      expect(res.headers['content-length']).toBeUndefined()
      expect(decoded(res).toString('utf-8')).toBe(ASSET_JS)
      expect(res.body.byteLength).toBeLessThan(identity.body.byteLength / 4)
    })

    it('leaves a range of a file exactly as the static handler cut it', async () => {
      const res = await get('/assets/index-abc123.js', { 'Accept-Encoding': BROWSER, Range: 'bytes=100-1099' })

      expect(res.status).toBe(206)
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.headers['content-range']).toBe(`bytes 100-1099/${Buffer.byteLength(ASSET_JS)}`)
      expect(res.headers['content-length']).toBe('1000')
      expect(res.body.toString('utf-8')).toBe(ASSET_JS.slice(100, 1100))
    })

    it('leaves a script under the threshold and an image alone', async () => {
      const tiny = await get('/assets/tiny-abc123.js', { 'Accept-Encoding': BROWSER })
      const png = await get('/assets/icon-abc123.png', { 'Accept-Encoding': BROWSER })

      expect(tiny.headers['content-encoding']).toBeUndefined()
      expect(tiny.body.toString('utf-8')).toBe('export default 1')
      expect(png.headers['content-encoding']).toBeUndefined()
      expect(png.headers['content-length']).toBe(String(ICON_PNG.byteLength))
      expect(png.body.equals(ICON_PNG)).toBe(true)
    })

    it('encodes the HTML entry and the SPA fallback, never cached', async () => {
      const html = await get('/', { 'Accept-Encoding': BROWSER })
      const fallback = await get('/some/deep/link', { 'Accept-Encoding': BROWSER })

      expect(html.headers['content-encoding']).toBe('gzip')
      expect(html.headers['cache-control']).toBe('no-cache')
      expect(decoded(html).toString('utf-8')).toContain('<title>App</title>')
      expect(decoded(fallback).equals(decoded(html))).toBe(true)
    })
  })
})

describe('isRelayedPath', () => {
  it.each([
    '/api/proxy/agent/account/v1/x',
    '/api/mcp-proxy/agent/server',
    '/api/llm-runtime/v1/messages',
    '/api/x-agent/chat',
    '/api/volumes/vol/file.json',
    '/api/web-fetch/x',
    '/api/agents/a/artifacts/board',
    '/api/agents/a/artifacts/board/',
    '/api/agents/a/artifacts/board/assets/app.js',
  ])('keeps %s outside the middleware', (path) => {
    expect(isRelayedPath(path)).toBe(true)
  })

  it.each([
    '/',
    '/assets/index-abc123.js',
    '/api/settings/models',
    '/api/agents',
    '/api/agents/a/artifacts',
    '/api/agents/a/sessions/s/messages',
    '/api/notifications/stream',
    '/api/proxy-rules',
  ])('leaves %s inside it', (path) => {
    expect(isRelayedPath(path)).toBe(false)
  })
})
