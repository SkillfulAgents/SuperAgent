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
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { COMPRESSION_THRESHOLD_BYTES, compressResponses, negotiateEncoding } from './compression'
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
  const encoding = res.headers['content-encoding']
  if (encoding === 'br') return brotliDecompressSync(res.body)
  if (encoding === 'gzip') return gunzipSync(res.body)
  return res.body
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
const SMALL = { ok: true, id: 'abc' }
const ASSET_JS = `export const table = ${JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ key: `entry-${i}`, label: `Label ${i}` })))}`
const ICON_PNG = randomBytes(8 * 1024)
const BR_AND_GZIP = 'gzip, deflate, br, zstd'

describe('response compression on the Node web server', () => {
  let root: string
  let port: number
  let server: ReturnType<typeof createServer>

  // What the stream handlers wait on. Each test that uses one replaces it.
  let sseGate = gate()
  let streamGate = gate()
  let streamCancelled = gate()

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

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'superagent-compression-'))
    await mkdir(join(root, 'assets'))
    await Promise.all([
      writeFile(join(root, 'index.html'), `<!doctype html><html><head><title>App</title></head><body>${'<p>shell</p>'.repeat(300)}</body></html>`),
      writeFile(join(root, 'assets', 'index-abc123.js'), ASSET_JS),
      writeFile(join(root, 'assets', 'tiny-abc123.js'), 'export default 1'),
      writeFile(join(root, 'assets', 'icon-abc123.png'), ICON_PNG),
      writeFile(join(root, 'manifest.webmanifest'), JSON.stringify({ name: 'App', icons: Array.from({ length: 80 }, (_, i) => ({ src: `/icon-${i}.png`, sizes: '192x192' })) })),
    ])

    const app = new Hono()
    app.use('*', compressResponses())

    app.get('/api/large', (c) => c.json(LARGE))
    app.get('/api/small', (c) => c.json(SMALL))
    app.get('/api/missing', (c) => c.json({ error: 'Not found', detail: LARGE }, 404))
    app.get('/api/cookies', (c) => {
      c.header('Set-Cookie', 'a=1; Path=/', { append: true })
      c.header('Set-Cookie', 'b=2; Path=/', { append: true })
      c.header('Cache-Control', 'private, no-store')
      c.header('X-Request-Id', 'r-1')
      return c.json(LARGE)
    })
    app.get('/api/weak-etag', (c) => {
      c.header('ETag', 'W/"1700000000-42"')
      return c.text(LARGE_JSON)
    })
    app.get('/api/strong-etag', (c) => {
      c.header('ETag', '"abc"')
      return c.text(LARGE_JSON)
    })
    app.get('/api/no-transform', (c) => {
      c.header('Cache-Control', 'no-transform')
      return c.json(LARGE)
    })
    app.get('/api/already-encoded', (c) => {
      c.header('Content-Encoding', 'gzip')
      c.header('Content-Type', 'application/json')
      return c.body(new Uint8Array(randomBytes(4096)))
    })
    app.get('/api/vary-origin', (c) => {
      c.header('Vary', 'Origin')
      return c.json(LARGE)
    })
    app.get('/api/dense', (c) => {
      // Text by its type, but nothing a compressor can shorten.
      c.header('Content-Type', 'text/plain')
      return c.body(new Uint8Array(randomBytes(4096)))
    })
    app.get('/api/image', (c) => {
      c.header('Content-Type', 'image/png')
      return c.body(new Uint8Array(ICON_PNG))
    })
    app.get('/api/partial', (c) => {
      c.header('Content-Range', `bytes 0-${LARGE_JSON.length - 1}/${LARGE_JSON.length * 2}`)
      return c.body(LARGE_JSON, 206, { 'Content-Type': 'application/json' })
    })
    app.get('/api/from-fetch', () => fetch(`data:application/json,${encodeURIComponent(LARGE_JSON)}`))

    // The session and notification streams: one event, then nothing until the test says so.
    app.get('/api/notifications/stream', (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: 'first', data: 'x'.repeat(4096) })
        await sseGate.promise
        await stream.writeSSE({ event: 'second', data: 'done' })
      }),
    )
    // A relayed upstream that is not SSE but still arrives over time, under a
    // type that would be compressible: an agent's download, a proxied JSON body.
    app.get('/api/agents/a/relayed', () => {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(`{"first":"${'y'.repeat(4096)}",`))
          await streamGate.promise
          controller.enqueue(encoder.encode('"second":true}'))
          controller.close()
        },
        cancel() {
          streamCancelled.open()
        },
      })
      return new Response(body, { headers: { 'Content-Type': 'application/json' } })
    })
    // What an agent container calls. In memory here, so only the path keeps it out.
    app.post('/api/proxy/a/anthropic/v1/messages', (c) => c.json(LARGE))
    app.get('/api/mcp-proxy/a/server', (c) => c.json(LARGE))
    app.get('/api/volumes/v/file.json', (c) => c.json(LARGE))

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

  describe('JSON built by a handler', () => {
    it('sends a large response as brotli to a client that takes it, at a fraction of the bytes', async () => {
      const identity = await get('/api/large')
      const res = await get('/api/large', { 'Accept-Encoding': BR_AND_GZIP })

      expect(res.status).toBe(200)
      expect(res.headers['content-encoding']).toBe('br')
      expect(res.headers['content-type']).toBe('application/json')
      expect(res.headers['vary']).toBe('Accept-Encoding')
      expect(Number(res.headers['content-length'])).toBe(res.body.byteLength)
      expect(res.headers['transfer-encoding']).toBeUndefined()
      expect(decoded(res).toString('utf-8')).toBe(LARGE_JSON)
      // The point of the middleware: a regression that stops encoding fails here.
      expect(identity.body.byteLength).toBe(Buffer.byteLength(LARGE_JSON))
      expect(res.body.byteLength).toBeLessThan(identity.body.byteLength / 4)
    })

    it('sends gzip to a client that takes only gzip, which is every browser over plain http', async () => {
      const res = await get('/api/large', { 'Accept-Encoding': 'gzip, deflate' })

      expect(res.headers['content-encoding']).toBe('gzip')
      expect(Number(res.headers['content-length'])).toBe(res.body.byteLength)
      expect(decoded(res).toString('utf-8')).toBe(LARGE_JSON)
      expect(res.body.byteLength).toBeLessThan(Buffer.byteLength(LARGE_JSON) / 4)
    })

    it.each([
      ['no Accept-Encoding', {}],
      ['identity only', { 'Accept-Encoding': 'identity' }],
      ['both codings refused', { 'Accept-Encoding': 'gzip;q=0, br;q=0' }],
      ['a coding this server does not produce', { 'Accept-Encoding': 'deflate, zstd' }],
    ] as Array<[string, Record<string, string>]>)('sends the body as it is with %s, and says the answer varies', async (_name, headers) => {
      const res = await get('/api/large', headers)

      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.headers['vary']).toBe('Accept-Encoding')
      expect(res.body.toString('utf-8')).toBe(LARGE_JSON)
    })

    it('leaves a response under the threshold alone', async () => {
      const res = await get('/api/small', { 'Accept-Encoding': BR_AND_GZIP })

      expect(JSON.stringify(SMALL).length).toBeLessThan(COMPRESSION_THRESHOLD_BYTES)
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(Number(res.headers['content-length'])).toBe(JSON.stringify(SMALL).length)
      expect(res.body.toString('utf-8')).toBe(JSON.stringify(SMALL))
    })

    it('keeps the status of an error response it encodes', async () => {
      const res = await get('/api/missing', { 'Accept-Encoding': BR_AND_GZIP })

      expect(res.status).toBe(404)
      expect(res.headers['content-encoding']).toBe('br')
      expect(JSON.parse(decoded(res).toString('utf-8')).error).toBe('Not found')
    })

    it('keeps every other header, each Set-Cookie included', async () => {
      const res = await get('/api/cookies', { 'Accept-Encoding': BR_AND_GZIP })

      expect(res.headers['content-encoding']).toBe('br')
      expect(res.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/'])
      expect(res.headers['cache-control']).toBe('private, no-store')
      expect(res.headers['x-request-id']).toBe('r-1')
    })

    it('adds to a Vary the handler already set', async () => {
      const res = await get('/api/vary-origin', { 'Accept-Encoding': BR_AND_GZIP })

      expect(res.headers['content-encoding']).toBe('br')
      expect(res.headers['vary']).toBe('Origin, Accept-Encoding')
    })

    it('answers HEAD without a body and without encoding', async () => {
      const res = await get('/api/large', { 'Accept-Encoding': BR_AND_GZIP }, 'HEAD')

      expect(res.status).toBe(200)
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.body.byteLength).toBe(0)
    })
  })

  describe('what is never encoded', () => {
    it('delivers an SSE event at once, with the stream still open behind it', async () => {
      sseGate = gate()
      const res = await open('/api/notifications/stream', { 'Accept-Encoding': BR_AND_GZIP, Accept: 'text/event-stream' })

      expect(res.headers['content-type']).toContain('text/event-stream')
      expect(res.headers['content-encoding']).toBeUndefined()
      // The handler is parked on the gate, so the stream cannot have ended:
      // this resolves only if the first event left the server without waiting
      // for the rest. A compressor or a buffer holding it back hangs here.
      const first = await nextChunk(res)
      expect(first).toContain('event: first')
      expect(first).not.toContain('event: second')

      const second = nextChunk(res)
      sseGate.open()
      expect(await second).toContain('event: second')
    })

    it('passes a body that arrives over time through chunk by chunk, whatever its type', async () => {
      streamGate = gate()
      const res = await open('/api/agents/a/relayed', { 'Accept-Encoding': BR_AND_GZIP })

      expect(res.headers['content-type']).toBe('application/json')
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.headers['content-length']).toBeUndefined()
      const first = await nextChunk(res)
      expect(first.startsWith('{"first":"yyyy')).toBe(true)

      let rest = ''
      const ended = new Promise<void>((resolve) => {
        res.on('data', (chunk: Buffer) => (rest += chunk.toString('utf-8')))
        res.on('end', resolve)
      })
      streamGate.open()
      await ended
      expect(JSON.parse(first + rest)).toEqual({ first: 'y'.repeat(4096), second: true })
    })

    it('tells the source of a passed-through stream when the client hangs up', async () => {
      streamGate = gate()
      streamCancelled = gate()
      const res = await open('/api/agents/a/relayed', { 'Accept-Encoding': BR_AND_GZIP })
      await nextChunk(res)

      res.destroy()
      await streamCancelled.promise
      streamGate.open()
    })

    it.each([
      ['POST', '/api/proxy/a/anthropic/v1/messages'],
      ['GET', '/api/mcp-proxy/a/server'],
      ['GET', '/api/volumes/v/file.json'],
    ])('does not look at what an agent container is sent (%s %s)', async (method, path) => {
      const res = await get(path, { 'Accept-Encoding': BR_AND_GZIP }, method)

      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.headers['vary']).toBeUndefined()
      expect(res.body.toString('utf-8')).toBe(LARGE_JSON)
    })

    it('leaves a range of a file exactly as the static handler cut it', async () => {
      const res = await get('/assets/index-abc123.js', { 'Accept-Encoding': BR_AND_GZIP, Range: 'bytes=100-1099' })

      expect(res.status).toBe(206)
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.headers['content-range']).toBe(`bytes 100-1099/${Buffer.byteLength(ASSET_JS)}`)
      expect(res.headers['content-length']).toBe('1000')
      expect(res.body.toString('utf-8')).toBe(ASSET_JS.slice(100, 1100))
    })

    it('leaves a partial response alone when the request carried no Range', async () => {
      const res = await get('/api/partial', { 'Accept-Encoding': BR_AND_GZIP })

      expect(res.status).toBe(206)
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.body.toString('utf-8')).toBe(LARGE_JSON)
    })

    it('leaves a body that is already encoded alone', async () => {
      const res = await get('/api/already-encoded', { 'Accept-Encoding': BR_AND_GZIP })

      expect(res.headers['content-encoding']).toBe('gzip')
      expect(res.body.byteLength).toBe(4096)
    })

    it('leaves media alone', async () => {
      const res = await get('/api/image', { 'Accept-Encoding': BR_AND_GZIP })

      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.headers['vary']).toBeUndefined()
      expect(res.body.equals(ICON_PNG)).toBe(true)
    })

    it('leaves a response marked no-transform alone', async () => {
      const res = await get('/api/no-transform', { 'Accept-Encoding': BR_AND_GZIP })

      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.body.toString('utf-8')).toBe(LARGE_JSON)
    })

    it('leaves a response with a strong ETag alone, and encodes one with a weak ETag', async () => {
      const strong = await get('/api/strong-etag', { 'Accept-Encoding': BR_AND_GZIP })
      const weak = await get('/api/weak-etag', { 'Accept-Encoding': BR_AND_GZIP })

      expect(strong.headers['content-encoding']).toBeUndefined()
      expect(strong.headers['etag']).toBe('"abc"')
      expect(weak.headers['content-encoding']).toBe('br')
      // The same validator either way, so a preview comparing it sees no change.
      expect(weak.headers['etag']).toBe('W/"1700000000-42"')
      expect((await get('/api/weak-etag')).headers['etag']).toBe('W/"1700000000-42"')
    })

    it('sends a body the compressor cannot shorten as it is, with its length', async () => {
      const res = await get('/api/dense', { 'Accept-Encoding': BR_AND_GZIP })

      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.headers['content-length']).toBe('4096')
      expect(res.body.byteLength).toBe(4096)
    })

    it('hands on a response that came straight from fetch()', async () => {
      const res = await get('/api/from-fetch', { 'Accept-Encoding': BR_AND_GZIP })

      expect(res.status).toBe(200)
      expect(res.headers['content-encoding']).toBeUndefined()
      expect(res.body.toString('utf-8')).toBe(LARGE_JSON)
    })
  })

  describe('the web build', () => {
    it('encodes a hashed script and keeps its permanent caching', async () => {
      const identity = await get('/assets/index-abc123.js')
      const res = await get('/assets/index-abc123.js', { 'Accept-Encoding': BR_AND_GZIP })

      expect(identity.headers['content-encoding']).toBeUndefined()
      expect(identity.headers['vary']).toBe('Accept-Encoding')
      expect(identity.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(Number(identity.headers['content-length'])).toBe(Buffer.byteLength(ASSET_JS))
      expect(identity.body.toString('utf-8')).toBe(ASSET_JS)

      expect(res.status).toBe(200)
      expect(res.headers['content-encoding']).toBe('br')
      expect(res.headers['vary']).toBe('Accept-Encoding')
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(res.headers['content-type']).toContain('javascript')
      expect(Number(res.headers['content-length'])).toBe(res.body.byteLength)
      expect(decoded(res).toString('utf-8')).toBe(ASSET_JS)
      expect(res.body.byteLength).toBeLessThan(identity.body.byteLength / 4)
    })

    it('serves the same encoded bytes again, and to requests that arrive together', async () => {
      const first = await get('/assets/index-abc123.js', { 'Accept-Encoding': 'gzip' })
      const together = await Promise.all(
        Array.from({ length: 6 }, () => get('/assets/index-abc123.js', { 'Accept-Encoding': 'gzip' })),
      )

      expect(first.headers['content-encoding']).toBe('gzip')
      for (const res of together) {
        expect(res.headers['content-encoding']).toBe('gzip')
        expect(Number(res.headers['content-length'])).toBe(res.body.byteLength)
        expect(res.body.equals(first.body)).toBe(true)
      }
      expect(decoded(first).toString('utf-8')).toBe(ASSET_JS)
      // The brotli copy is a different entry, not the gzip one under another name.
      const br = await get('/assets/index-abc123.js', { 'Accept-Encoding': 'br' })
      expect(br.headers['content-encoding']).toBe('br')
      expect(decoded(br).toString('utf-8')).toBe(ASSET_JS)
    })

    it('leaves a small script and an image alone', async () => {
      const tiny = await get('/assets/tiny-abc123.js', { 'Accept-Encoding': BR_AND_GZIP })
      const png = await get('/assets/icon-abc123.png', { 'Accept-Encoding': BR_AND_GZIP })

      expect(tiny.headers['content-encoding']).toBeUndefined()
      expect(tiny.body.toString('utf-8')).toBe('export default 1')
      expect(png.headers['content-encoding']).toBeUndefined()
      expect(png.headers['content-length']).toBe(String(ICON_PNG.byteLength))
      expect(png.body.equals(ICON_PNG)).toBe(true)
    })

    it('encodes the HTML entry and a stable-named manifest, each with its own caching', async () => {
      const html = await get('/', { 'Accept-Encoding': BR_AND_GZIP })
      const fallback = await get('/some/deep/link', { 'Accept-Encoding': BR_AND_GZIP })
      const manifest = await get('/manifest.webmanifest', { 'Accept-Encoding': BR_AND_GZIP })

      expect(html.headers['content-encoding']).toBe('br')
      expect(html.headers['cache-control']).toBe('no-cache')
      expect(decoded(html).toString('utf-8')).toContain('<title>App</title>')
      expect(decoded(fallback).equals(decoded(html))).toBe(true)
      expect(manifest.headers['content-encoding']).toBe('br')
      expect(manifest.headers['cache-control']).toBe('public, max-age=3600, must-revalidate')
      expect(JSON.parse(decoded(manifest).toString('utf-8')).name).toBe('App')
    })
  })
})

describe('negotiateEncoding', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['identity', null],
    ['deflate', null],
    ['gzip', 'gzip'],
    ['gzip, deflate', 'gzip'],
    ['gzip, deflate, br, zstd', 'br'],
    ['BR', 'br'],
    ['br;q=0, gzip', 'gzip'],
    ['br;q=0.5, gzip;q=0.9', 'gzip'],
    ['gzip;q=0.5, br;q=0.5', 'br'],
    ['gzip;q=0', null],
    ['*', 'br'],
    ['*;q=0', null],
    ['*;q=0, gzip', 'gzip'],
    ['gzip;q=abc', 'gzip'],
  ] as Array<[string | undefined, string | null]>)('answers %j with %j', (header, expected) => {
    expect(negotiateEncoding(header)).toBe(expected)
  })
})
