import fs from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { z } from 'zod'
import type { JsonlEntry, JsonlMessageEntry } from '@shared/lib/types/agent'

/**
 * Media references: images ride in message payloads as an address instead of
 * inline base64, and the bytes are fetched separately, on demand.
 *
 * Transcripts store screenshots and image tool results as base64 inside the
 * JSONL row. That base64 is the bulk of a transcript's bytes (measured on real
 * sessions: ~5MB of 15MB, and stored TWICE — once in the tool_result block,
 * once again under `toolUseResult.file`), and every message page re-shipped all
 * of it to every viewer. A ref collapses each image to ~200 bytes on the wire.
 *
 * ADDRESSING. A ref is the byte span of the base64 payload itself, not of the
 * row holding it — the rows are multi-MB precisely because of the images, so
 * "seek to the row, then find the image" would materialize the very thing
 * we're avoiding. Serving a ref is a ranged read of exactly the payload piped
 * through a streaming base64 decoder: O(chunk) memory, no line assembly, no
 * JSON parse. The span is exact because base64's alphabet needs no JSON
 * escaping, so the payload's bytes on disk are byte-identical to the decoded
 * string value.
 *
 * VALIDITY. Transcripts are rewritten in place by message/tool-call deletion
 * and retention, which shifts every offset after the edit. A ref therefore
 * carries the source row's uuid AND the byte offset that uuid sat at, so a
 * read can confirm the row is still where the ref says with a 36-byte read
 * rather than a scan. That check plus exact quote delimiters around the
 * payload and an image magic-number sniff of the head means a stale ref
 * reliably fails closed (410) instead of serving unrelated bytes.
 *
 * The same checks are what make client-supplied refs safe to honor: a forged
 * span has to land on a quote-delimited base64 string whose head decodes to a
 * known image type, which in a transcript means an actual image — one the
 * caller could already read through the messages endpoint they are authorized
 * for. The response's Content-Type comes from the sniff, never from the ref,
 * so a ref cannot dictate how bytes are interpreted.
 */

/** Below this decoded size, keep the image inline: a ref costs a round trip
 * plus ~200 bytes of address, which is a loss for small icons. */
export const MEDIA_INLINE_MAX_BYTES = 16 * 1024

/** Ceiling on an addressable payload, so a forged ref can't ask the process to
 * stream an arbitrary span. Well above any real screenshot. */
const MEDIA_MAX_BASE64_LENGTH = 64 * 1024 * 1024

const QUOTE_BYTE = 0x22

/** Wire shape replacing an inline image block. `url` is an API path (the
 * renderer prefixes its API base) so no consumer needs the session's identity
 * threaded down to it. */
export interface MediaRefBlock {
  type: 'media_ref'
  id: string
  mimeType: string
  /** Decoded size, for sizing a placeholder before the bytes arrive. */
  bytes: number
  url: string
}

// Single-letter keys: this rides in the URL, and a page can carry dozens.
const mediaRefSchema = z.object({
  v: z.literal(1),
  /** uuid of the transcript row holding the payload. */
  u: z.string().min(1).max(64),
  /** Byte offset of that uuid's value in the file (validity check). */
  o: z.number().int().nonnegative(),
  /** Byte offset of the base64 payload. */
  s: z.number().int().nonnegative(),
  /** Length of the base64 payload in bytes. */
  l: z.number().int().positive().max(MEDIA_MAX_BASE64_LENGTH),
})

export type MediaRef = z.infer<typeof mediaRefSchema>

export function encodeMediaRef(ref: MediaRef): string {
  return Buffer.from(JSON.stringify(ref), 'utf-8').toString('base64url')
}

/** Undefined for anything that isn't a ref this process could have minted —
 * the value is client-supplied and reaches a file read. */
export function decodeMediaRef(encoded: string): MediaRef | undefined {
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'))
  } catch {
    return undefined
  }
  const parsed = mediaRefSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

function mediaUrl(agentSlug: string, sessionId: string, id: string): string {
  return (
    `/api/agents/${encodeURIComponent(agentSlug)}` +
    `/sessions/${encodeURIComponent(sessionId)}/media/${id}`
  )
}

/** Decoded byte length of a base64 payload of `length` bytes ending in `pad` '=' chars. */
function decodedLength(length: number, pad: number): number {
  return Math.max(0, (length / 4) * 3 - pad)
}

interface ImageBlockLike {
  type: string
  source?: { type?: string; media_type?: string; data?: string }
  data?: string
  mimeType?: string
}

/** The base64 payload and declared type of an image block, in either shape the
 * transcripts use: Anthropic's `{source: {data, media_type}}` and MCP's
 * `{data, mimeType}`. */
function imagePayload(block: ImageBlockLike): { data: string; mimeType: string } | undefined {
  if (block.type !== 'image') return undefined
  if (typeof block.source?.data === 'string' && block.source.data.length > 0) {
    return { data: block.source.data, mimeType: block.source.media_type || 'image/png' }
  }
  if (typeof block.data === 'string' && block.data.length > 0) {
    return { data: block.data, mimeType: block.mimeType || 'image/png' }
  }
  return undefined
}

export interface MediaRefContext {
  agentSlug: string
  sessionId: string
  /** Absolute byte offset of `line`'s first byte. */
  lineOffset: number
  line: Buffer
}

/** Locate `needle` in `line` at or after `from`, retrying from the start so a
 * block order that doesn't match byte order still resolves. Returns -1 when the
 * payload isn't byte-identical to its decoded value, which leaves it inline. */
function findPayload(line: Buffer, needle: string, from: number): number {
  const at = line.indexOf(needle, from, 'latin1')
  if (at !== -1) return at
  return from === 0 ? -1 : line.indexOf(needle, 0, 'latin1')
}

/**
 * Replace inline base64 images in one transcript entry with refs, in place.
 *
 * Called with the raw line the entry was parsed from, so payload offsets are
 * exact. Applied at parse time rather than after the transform: the entries of
 * a page window are all held at once, so stripping here keeps the base64 out of
 * the page's peak memory as well as off the wire — including the duplicate
 * copy under `toolUseResult`, which never reaches the wire but is half of an
 * image-heavy window's retained bytes.
 *
 * Anything not provably locatable is left untouched: correctness of the page
 * never depends on a ref being minted.
 */
export function replaceInlineMediaWithRefs(entry: JsonlEntry, ctx: MediaRefContext): void {
  const message = (entry as JsonlMessageEntry).message
  const uuid = (entry as JsonlMessageEntry).uuid
  if (typeof uuid !== 'string' || uuid.length === 0) return

  // Offset of the uuid VALUE (past the opening quote of `"uuid":"…"`).
  const uuidKeyAt = ctx.line.indexOf(`"uuid":"${uuid}"`, 0, 'latin1')
  if (uuidKeyAt === -1) return
  const uuidOffset = ctx.lineOffset + uuidKeyAt + '"uuid":"'.length

  // Payloads are minted in document order and the search advances with them,
  // so repeated identical images resolve to distinct spans.
  let cursor = 0

  const refFor = (block: ImageBlockLike): MediaRefBlock | undefined => {
    const payload = imagePayload(block)
    if (!payload) return undefined
    const pad = payload.data.endsWith('==') ? 2 : payload.data.endsWith('=') ? 1 : 0
    const bytes = decodedLength(payload.data.length, pad)
    if (bytes < MEDIA_INLINE_MAX_BYTES) return undefined
    if (payload.data.length > MEDIA_MAX_BASE64_LENGTH) return undefined
    const at = findPayload(ctx.line, payload.data, cursor)
    if (at === -1) return undefined
    cursor = at + payload.data.length
    const id = encodeMediaRef({
      v: 1,
      u: uuid,
      o: uuidOffset,
      s: ctx.lineOffset + at,
      l: payload.data.length,
    })
    return {
      type: 'media_ref',
      id,
      mimeType: payload.mimeType,
      bytes,
      url: mediaUrl(ctx.agentSlug, ctx.sessionId, id),
    }
  }

  if (Array.isArray(message?.content)) {
    const content = message.content as unknown[]
    for (let i = 0; i < content.length; i++) {
      const block = content[i] as ImageBlockLike & { content?: unknown }
      if (!block || typeof block !== 'object') continue
      // Images inside a tool_result — the shape that reaches the wire as
      // `toolCall.result`, and the reason this exists.
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        const inner = block.content as unknown[]
        for (let j = 0; j < inner.length; j++) {
          const ref = refFor(inner[j] as ImageBlockLike)
          if (ref) inner[j] = ref
        }
        continue
      }
      // Top-level images (pasted attachments). The transform drops these from
      // the rendered text, so this is purely about not holding them in memory.
      const ref = refFor(block)
      if (ref) content[i] = ref
    }
  }

  // The SDK writes the same base64 a second time under `toolUseResult.file`.
  // Nothing serializes it, so it needs no ref — only release.
  const toolUseResult = (entry as JsonlMessageEntry).toolUseResult as
    | { file?: { base64?: unknown } }
    | undefined
  if (typeof toolUseResult?.file?.base64 === 'string') {
    delete toolUseResult.file.base64
  }
}

/** Magic numbers of the raster types transcripts carry. SVG is deliberately
 * absent: it isn't sniffable and it executes script when served inline. */
const IMAGE_SIGNATURES: Array<{ mimeType: string; magic: number[] }> = [
  { mimeType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mimeType: 'image/bmp', magic: [0x42, 0x4d] },
]

function sniffImageType(head: Buffer): string | undefined {
  for (const { mimeType, magic } of IMAGE_SIGNATURES) {
    if (head.length >= magic.length && magic.every((b, i) => head[i] === b)) return mimeType
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return undefined
}

const BASE64_INVALID = /[^A-Za-z0-9+/=]/

/** base64 bytes in, decoded bytes out, without ever holding the whole payload.
 * Buffer.from silently drops characters outside the alphabet, so a chunk that
 * isn't base64 has to fail loudly here rather than decode to plausible junk. */
function createBase64DecodeStream(): Transform {
  let carry = ''
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const text = carry + chunk.toString('latin1')
      if (BASE64_INVALID.test(text)) {
        callback(new Error('media payload is not base64'))
        return
      }
      const usable = text.length - (text.length % 4)
      carry = text.slice(usable)
      callback(null, usable > 0 ? Buffer.from(text.slice(0, usable), 'base64') : undefined)
    },
    flush(callback) {
      callback(null, carry.length > 0 ? Buffer.from(carry, 'base64') : undefined)
    },
  })
}

export interface MediaBlob {
  stream: Readable
  mimeType: string
  bytes: number
}

/**
 * Open the bytes a ref addresses, or undefined if the ref no longer resolves
 * (rewritten transcript, forged span) — which the route answers with 410.
 *
 * Validation is four small reads, no scan: the row's uuid still sits at the
 * recorded offset; the payload is quote-delimited exactly as recorded; its head
 * decodes to a known image type. Only then is a stream opened.
 */
export async function openMediaBlob(
  jsonlPath: string,
  ref: MediaRef,
  signal?: AbortSignal
): Promise<MediaBlob | undefined> {
  signal?.throwIfAborted()
  let handle: fs.promises.FileHandle
  try {
    handle = await fs.promises.open(jsonlPath, 'r')
  } catch {
    return undefined
  }
  let opened = false
  try {
    const stat = await handle.stat()
    const uuidEnd = ref.o + ref.u.length
    const payloadEnd = ref.s + ref.l
    if (stat.size < Math.max(uuidEnd, payloadEnd) + 1 || ref.o < 1 || ref.s < 1) return undefined

    // The row that owned this payload is still at the recorded offset.
    const uuidWindow = Buffer.allocUnsafe(ref.u.length + 2)
    const { bytesRead: uuidRead } = await handle.read(
      uuidWindow, 0, uuidWindow.length, ref.o - 1
    )
    if (uuidRead < uuidWindow.length) return undefined
    if (uuidWindow[0] !== QUOTE_BYTE || uuidWindow[uuidWindow.length - 1] !== QUOTE_BYTE) {
      return undefined
    }
    if (uuidWindow.subarray(1, uuidWindow.length - 1).toString('latin1') !== ref.u) return undefined

    signal?.throwIfAborted()
    // The payload is still exactly this JSON string: quote before it, and
    // quote right after its last byte.
    const openQuote = Buffer.allocUnsafe(1)
    if ((await handle.read(openQuote, 0, 1, ref.s - 1)).bytesRead < 1) return undefined
    if (openQuote[0] !== QUOTE_BYTE) return undefined

    // Trailing window: the padding (needed for an exact Content-Length) and
    // the closing quote, in one read.
    const tail = Buffer.allocUnsafe(3)
    if ((await handle.read(tail, 0, 3, payloadEnd - 2)).bytesRead < 3) return undefined
    if (tail[2] !== QUOTE_BYTE) return undefined
    const pad = tail[1] === 0x3d ? (tail[0] === 0x3d ? 2 : 1) : 0

    signal?.throwIfAborted()
    // Head sniff: 12 decoded bytes is enough for every signature above.
    const headBase64 = Buffer.allocUnsafe(Math.min(20, ref.l))
    const { bytesRead: headRead } = await handle.read(headBase64, 0, headBase64.length, ref.s)
    if (headRead < headBase64.length) return undefined
    const headText = headBase64.toString('latin1')
    if (BASE64_INVALID.test(headText)) return undefined
    const usable = headText.length - (headText.length % 4)
    const mimeType = sniffImageType(Buffer.from(headText.slice(0, usable), 'base64'))
    if (!mimeType) return undefined

    // createReadStream owns the handle from here and closes it on end/error.
    const stream = handle.createReadStream({ start: ref.s, end: payloadEnd - 1 })
    opened = true
    const decoded = stream.pipe(createBase64DecodeStream())
    // The decoder failing mid-payload (only reachable if the file changed
    // between the checks above and the read) has to tear the source down too,
    // or the handle stays open until GC.
    decoded.on('error', () => stream.destroy())
    return { stream: decoded, mimeType, bytes: decodedLength(ref.l, pad) }
  } catch (error) {
    if (signal?.aborted) throw error
    return undefined
  } finally {
    if (!opened) await handle.close()
  }
}
