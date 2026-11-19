import { brotliCompress, constants as zlib, gzip } from 'node:zlib'
import type { Context, MiddlewareHandler } from 'hono'
import { isContainerFacingPath } from '../api/middleware/local-mode-auth'

/**
 * Response compression for the Node web server (`src/web/server.ts`), the one
 * entry point whose responses cross a real network with nothing in front of
 * them that compresses. The desktop app's server answers loopback, where the
 * CPU buys nothing, and Cloudflare compresses at its edge.
 *
 * The rule that keeps this safe: **only a body that is already complete is
 * encoded.** That is either a response the handler built from a value in
 * memory (`c.json`, `c.text`, `c.html`), or a file of the web build, whose size
 * is on disk. It is encoded in one piece and sent with its own Content-Length.
 * A body that arrives over time (an SSE stream, a proxied upstream, a container
 * download) is never run through a compressor and never held back: this
 * middleware has no streaming encoder to put it through.
 */

export type ContentCoding = 'br' | 'gzip'

/** Below this a body fits one packet either way, and the header costs more than it saves. */
export const COMPRESSION_THRESHOLD_BYTES = 1024

/** A complete body larger than this goes out as it is rather than being held in memory twice. */
const MAX_BODY_BYTES = 16 * 1024 * 1024

/** What the encoded copies of the build's immutable files may hold, in total. */
const STATIC_CACHE_MAX_BYTES = 64 * 1024 * 1024

/**
 * Brotli quality for a body encoded on every request. Measured on a 128 KB
 * model-catalog response: quality 4 is smaller than gzip's default level and
 * takes about as long as gzip level 1 (see the PR that added this file).
 */
const DYNAMIC_BROTLI_QUALITY = 4
/** gzip for a client that does not take brotli, which is every browser over plain http. */
const DYNAMIC_GZIP_LEVEL = 6
/** A content-hashed file is encoded once per process and kept, so it can afford more. */
const STATIC_BROTLI_QUALITY = 9
const STATIC_GZIP_LEVEL = 9

/**
 * Text formats, and the structured ones built on them. Deliberately a list:
 * images, video, audio, archives and fonts are compressed already, and
 * `application/octet-stream` says nothing about what it holds.
 */
const COMPRESSIBLE_TYPE =
  /^(?:text\/(?!event-stream)[\w.+-]+|application\/(?:json|javascript|xml|wasm|manifest\+json|[\w.-]+\+(?:json|xml))|image\/svg\+xml)$/i

/** Statuses with no body, or with a part of one. */
const UNENCODABLE_STATUS = new Set([204, 205, 206, 304])

const STATIC_FILE_KEY = 'compression.staticFile'

/**
 * Say that this response is a file of the web build, read from disk. Its
 * stream ends at the size its Content-Length already states, so reading it
 * whole is bounded. Called from `serveStatic`'s `onFound`.
 */
export function markStaticFile(c: Context, filePath: string): void {
  c.set(STATIC_FILE_KEY as never, filePath as never)
}

/**
 * The endpoints an agent container calls: the LLM, API and MCP proxies, the
 * volumes it mounts. Their bodies are relayed from somewhere else to a client
 * on this machine's own bridge, so they are not examined at all.
 */
const isRelayPath = isContainerFacingPath

/**
 * The coding to answer `Accept-Encoding` with, or null for identity. Brotli
 * when the client takes both, unless it weights gzip higher; `q=0` is a refusal.
 */
export function negotiateEncoding(acceptEncoding: string | undefined): ContentCoding | null {
  if (!acceptEncoding) return null
  const weights = new Map<string, number>()
  for (const part of acceptEncoding.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (!name) continue
    let q = 1
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param)
      if (match) q = Number(match[1])
    }
    weights.set(name.trim(), Number.isFinite(q) ? q : 0)
  }
  const weightOf = (coding: string) => weights.get(coding) ?? weights.get('*') ?? 0
  const br = weightOf('br')
  const gz = weightOf('gzip')
  if (br <= 0 && gz <= 0) return null
  return br >= gz ? 'br' : 'gzip'
}

function encode(body: Uint8Array, encoding: ContentCoding, isStatic: boolean): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, result: Buffer) => (error ? reject(error) : resolve(result))
    if (encoding === 'br') {
      brotliCompress(
        body,
        {
          params: {
            [zlib.BROTLI_PARAM_QUALITY]: isStatic ? STATIC_BROTLI_QUALITY : DYNAMIC_BROTLI_QUALITY,
            [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
            [zlib.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
          },
        },
        done,
      )
    } else {
      gzip(body, { level: isStatic ? STATIC_GZIP_LEVEL : DYNAMIC_GZIP_LEVEL }, done)
    }
  })
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

type BodyRead =
  | { complete: true; bytes: Uint8Array }
  /** Not complete: the same bytes, in the same order, for the client to read as they come. */
  | { complete: false; body: ReadableStream<Uint8Array> }

/** A stream that yields what was already taken from `reader`, then the rest of it. */
function resume(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  taken: Uint8Array[],
  pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined,
): ReadableStream<Uint8Array> {
  let next = pending
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of taken) controller.enqueue(chunk)
    },
    async pull(controller) {
      const read = next ?? reader.read()
      next = undefined
      const result = await read
      if (result.done) controller.close()
      else controller.enqueue(result.value)
    },
    // A client that hangs up cancels this; the source has to hear it.
    cancel: (reason) => reader.cancel(reason),
  })
}

/**
 * Take the body if all of it is there to take.
 *
 * A body built from a string or a buffer hands over every byte and closes
 * without waiting on anything, so its reads settle before the event loop turns.
 * A body fed by a socket, a file or a generator does not. The reads here are
 * given until the next turn and no longer: one that is still open then is a
 * stream, and it is handed back whole, having been delayed by that one turn.
 */
async function readIfComplete(source: ReadableStream<Uint8Array>): Promise<BodyRead> {
  const reader = source.getReader()
  const nextTurn = new Promise<null>((resolve) => setImmediate(() => resolve(null)))
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const pending = reader.read()
    const result = await Promise.race([pending, nextTurn])
    if (result === null) return { complete: false, body: resume(reader, chunks, pending) }
    if (result.done) return { complete: true, bytes: concat(chunks, size) }
    chunks.push(result.value)
    size += result.value.byteLength
    if (size > MAX_BODY_BYTES) return { complete: false, body: resume(reader, chunks, undefined) }
  }
}

/** A file's stream, read to its end. Its length was checked against the limit beforehand. */
async function readAll(source: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of source as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    size += chunk.byteLength
  }
  return concat(chunks, size)
}

function appendVary(headers: Headers): void {
  const vary = headers.get('Vary')
  if (!vary) headers.set('Vary', 'Accept-Encoding')
  else if (vary !== '*' && !/(?:^|,)\s*accept-encoding\s*(?:,|$)/i.test(vary)) {
    headers.set('Vary', `${vary}, Accept-Encoding`)
  }
}

/** Replace the response outright; Hono's setter would otherwise copy the old headers over the new. */
function respond(c: Context, body: Uint8Array | ReadableStream<Uint8Array>, headers: Headers): void {
  const status = c.res.status
  c.res = undefined
  c.res = new Response(body as BodyInit, { status, headers })
}

export function compressResponses(): MiddlewareHandler {
  // Encoded copies of the build's content-hashed files, which cannot change
  // under their name. Holds the promise, so requests that arrive together for
  // a file not yet encoded share one pass over it.
  const staticCache = new Map<string, Promise<Uint8Array>>()
  let staticCacheBytes = 0

  return async function compression(c, next) {
    await next()

    if (isRelayPath(c.req.path)) return
    const res = c.res
    if (c.req.method === 'HEAD' || c.req.header('Range') !== undefined) return
    if (res.status < 200 || UNENCODABLE_STATUS.has(res.status)) return
    if (res.headers.has('Content-Encoding') || res.headers.has('Content-Range')) return
    const contentType = res.headers.get('Content-Type')?.split(';', 1)[0].trim()
    if (!contentType || !COMPRESSIBLE_TYPE.test(contentType)) return
    if (/\bno-transform\b/i.test(res.headers.get('Cache-Control') ?? '')) return
    // A strong validator names these exact bytes; a weak one names the content.
    const etag = res.headers.get('ETag')
    if (etag && !etag.startsWith('W/')) return
    const declared = res.headers.get('Content-Length')
    const declaredLength = declared === null ? undefined : Number(declared)
    if (declaredLength !== undefined && !(declaredLength >= COMPRESSION_THRESHOLD_BYTES)) return

    // From here on the answer depends on what the client accepts, whichever way it goes.
    try {
      appendVary(res.headers)
    } catch {
      // A response handed straight on from `fetch()` has headers that cannot be
      // set. It came from somewhere else; it goes out as it arrived.
      return
    }
    const encoding = negotiateEncoding(c.req.header('Accept-Encoding'))
    if (!encoding || !res.body) return

    const staticFile = c.get(STATIC_FILE_KEY as never) as string | undefined
    let bytes: Uint8Array | undefined
    let encoded: Promise<Uint8Array>

    if (staticFile !== undefined) {
      // Only a file whose size is known and within the limit; anything else stays a stream.
      if (declaredLength === undefined || declaredLength > MAX_BODY_BYTES) return
      const immutable = /\bimmutable\b/i.test(res.headers.get('Cache-Control') ?? '')
      const key = `${encoding}\0${declaredLength}\0${staticFile}`
      const cached = immutable ? staticCache.get(key) : undefined
      if (cached) {
        // The file was opened to answer this; it is not going to be read.
        void res.body.cancel().catch(() => {})
        encoded = cached
      } else {
        bytes = await readAll(res.body)
        encoded = encode(bytes, encoding, immutable)
        if (immutable && staticCacheBytes < STATIC_CACHE_MAX_BYTES) {
          staticCache.set(key, encoded)
          encoded.then(
            (result) => {
              staticCacheBytes += result.byteLength
            },
            () => staticCache.delete(key),
          )
        }
      }
    } else {
      const read = await readIfComplete(res.body)
      if (!read.complete) {
        respond(c, read.body, new Headers(res.headers))
        return
      }
      bytes = read.bytes
      if (bytes.byteLength < COMPRESSION_THRESHOLD_BYTES) {
        respond(c, bytes, new Headers(res.headers))
        return
      }
      encoded = encode(bytes, encoding, false)
    }

    const headers = new Headers(res.headers)
    let body: Uint8Array
    try {
      body = await encoded
    } catch (error) {
      console.error('Response compression failed, sending the body as it is:', error)
      if (!bytes) throw error
      body = bytes
    }
    if (bytes && body.byteLength >= bytes.byteLength) {
      // Nothing gained (already dense). The body was read, so it is sent from memory.
      headers.set('Content-Length', String(bytes.byteLength))
      respond(c, bytes, headers)
      return
    }
    headers.set('Content-Encoding', encoding)
    headers.set('Content-Length', String(body.byteLength))
    // A range of the encoded bytes is not something this server can answer.
    headers.delete('Accept-Ranges')
    respond(c, body, headers)
  }
}
