import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { Readable, Transform, pipeline } from 'node:stream'
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
 * names three things, each covering what the others cannot:
 *
 *   - the source row's uuid AND the byte offset that uuid sat at, so a read
 *     confirms the row is still there with a 36-byte read rather than a scan;
 *   - exact quote delimiters, so the span is still one whole JSON string;
 *   - a sampled content fingerprint, because the first two still can't tell
 *     two images inside ONE row apart — deleting the first can slide the
 *     second into the first's exact span with the uuid untouched.
 *
 * Together they make a stale ref fail closed (410) rather than serve the wrong
 * image, which is what lets the response be cached as immutable.
 *
 * The same checks are what make client-supplied refs safe to honor: a forged
 * span has to land on a quote-delimited base64 string that matches a
 * fingerprint the caller would have to already know and whose head decodes to
 * a known image type. The response's Content-Type comes from the sniff, never
 * from the ref, so a ref cannot dictate how bytes are interpreted.
 *
 * Only formats the sniff recognizes are minted at all: a ref the endpoint
 * could never serve would replace a working inline image with a permanent
 * placeholder.
 *
 * KNOWN GAPS, deliberately left:
 *
 *   - Tool results whose content is a JSON *string* of blocks (rather than an
 *     array) keep their images inline. The renderer parses that form, so the
 *     shape is reachable in principle; it does not occur in practice — a scan
 *     of real transcripts found 282 image tool results, all arrays, none
 *     serialized.
 *   - A ref minted before a remote rewrite stays in a client's already-loaded
 *     history and will 410 until that view is refetched. Fixing it properly
 *     means carrying a transcript generation through responses so a client can
 *     tell its addresses are stale, which is the same mechanism the paged
 *     reader wants for cursor continuity and belongs with it.
 */

/** Below this decoded size, keep the image inline: a ref costs a round trip
 * plus ~200 bytes of address, which is a loss for small icons. */
export const MEDIA_INLINE_MAX_BYTES = 16 * 1024

/** Ceiling on an addressable payload, so a forged ref can't ask the process to
 * stream an arbitrary span. Well above any real screenshot. */
const MEDIA_MAX_BASE64_LENGTH = 64 * 1024 * 1024

const QUOTE_BYTE = 0x22

/** Wire shape replacing an inline image block.
 *
 * Deliberately carries no URL. Tool results are untrusted text that a client
 * parses as content blocks, so a block that declares its own address would let
 * any tool output name one — the consumer builds the media path from `id` plus
 * a session identity it already trusts. */
export interface MediaRefBlock {
  type: 'media_ref'
  id: string
  mimeType: string
  /** Decoded size, for sizing a placeholder before the bytes arrive. */
  bytes: number
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
  /** Sampled content fingerprint — what makes the address name one image
   * rather than one location (see sampleFingerprint). */
  h: z.string().min(1).max(32),
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

/** Decoded byte length of a base64 payload of `length` bytes ending in `pad`
 * '=' chars. Unpadded base64 is valid and its length need not divide by four,
 * so this floors rather than assuming it does — the result is a Content-Length
 * and must be an integer that matches the bytes actually served. */
function decodedLength(length: number, pad: number): number {
  return Math.max(0, Math.floor((length * 3) / 4) - pad)
}

/** Identity of the payload's *content*, cheap to verify without reading it all.
 *
 * Offsets and the row uuid together still can't distinguish two images inside
 * one row: deleting the first can slide the second into the first's exact span
 * with the uuid untouched, and the old ref would then serve the wrong image
 * under a year-long immutable cache. Sampling head/middle/tail pins content
 * with three small reads. Two payloads that agree on all of it are, for
 * serving purposes, the same image.
 */
function sampleFingerprint(head: string, mid: string, tail: string, length: number): string {
  return createHash('sha256')
    .update(`${length}:${head}:${mid}:${tail}`)
    .digest('base64url')
    .slice(0, 16)
}

const FINGERPRINT_SAMPLE_LENGTH = 64

/** Byte offsets of the three sampled windows within a payload of `length`. */
function sampleOffsets(length: number): { head: number; mid: number; tail: number; size: number } {
  const size = Math.min(FINGERPRINT_SAMPLE_LENGTH, length)
  return {
    head: 0,
    mid: Math.max(0, Math.floor(length / 2)),
    tail: Math.max(0, length - size),
    size,
  }
}

function fingerprintOf(data: string): string {
  const { head, mid, tail, size } = sampleOffsets(data.length)
  return sampleFingerprint(
    data.slice(head, head + size),
    data.slice(mid, mid + size),
    data.slice(tail, tail + size),
    data.length
  )
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
  /** Absolute byte offset of `line`'s first byte. */
  lineOffset: number
  line: Buffer
}

/** Locate the JSON *string field* holding `needle`, at or after `from`.
 *
 * The same base64 can also appear inside a text block in the same row (a tool
 * echoing its own output), and that occurrence is not a quote-delimited field
 * of its own — minting there produces a ref whose serving-side delimiter check
 * rejects it, i.e. a permanently dead image. So a match only counts when the
 * bytes either side are the quotes that close it, and the search continues
 * past matches that aren't. Retries from the start so a block order that
 * doesn't match byte order still resolves. -1 leaves the image inline. */
function findPayload(line: Buffer, needle: string, from: number): number {
  const scan = (start: number): number => {
    let at = line.indexOf(needle, start, 'latin1')
    while (at !== -1) {
      const before = at - 1
      const after = at + needle.length
      if (before >= 0 && line[before] === QUOTE_BYTE && line[after] === QUOTE_BYTE) return at
      at = line.indexOf(needle, at + 1, 'latin1')
    }
    return -1
  }
  const found = scan(from)
  if (found !== -1) return found
  return from === 0 ? -1 : scan(0)
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
    // Mint only what the endpoint can serve. Serving identifies content by
    // magic number, so an image in a format that isn't sniffable (SVG, AVIF,
    // ICO, …) would become a ref that answers 410 forever — replacing an image
    // that renders inline today with a permanent placeholder. Those stay
    // inline: the type is decided here, once, for both ends.
    const mimeType = sniffImageType(Buffer.from(payload.data.slice(0, 24), 'base64'))
    if (!mimeType) return undefined
    const at = findPayload(ctx.line, payload.data, cursor)
    if (at === -1) return undefined
    cursor = at + payload.data.length
    const id = encodeMediaRef({
      v: 1,
      u: uuid,
      o: uuidOffset,
      s: ctx.lineOffset + at,
      l: payload.data.length,
      h: fingerprintOf(payload.data),
    })
    return { type: 'media_ref', id, mimeType, bytes }
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
/** A well-formed run of base64: alphabet characters, then at most two '='. */
const BASE64_CHUNK = /^[A-Za-z0-9+/]*={0,2}$/

/** base64 bytes in, decoded bytes out, without ever holding the whole payload.
 * Buffer.from silently drops characters outside the alphabet, so a chunk that
 * isn't base64 has to fail loudly here rather than decode to plausible junk. */
function createBase64DecodeStream(): Transform {
  let carry = ''
  // '=' is legal only as the final one or two characters of the whole payload;
  // anything after it would decode to different bytes than the payload holds.
  // Counted over arriving characters, never over `carry` — the carry still
  // holds the padding it already accounted for.
  let padding = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const incoming = chunk.toString('latin1')
      if (!BASE64_CHUNK.test(incoming)) {
        callback(new Error('media payload is not base64'))
        return
      }
      const added = incoming.length - incoming.replace(/=+$/, '').length
      if ((padding > 0 && /[^=]/.test(incoming)) || padding + added > 2) {
        callback(new Error('media payload has misplaced base64 padding'))
        return
      }
      padding += added
      const text = carry + incoming
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

/** A client hanging up mid-image is the normal case, not a fault to report. */
function isBenignStreamError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'ABORT_ERR' || code === 'ERR_STREAM_PREMATURE_CLOSE'
}

/** Fill `buf` from `position`, looping over short reads. A single positional
 * read is allowed to return fewer bytes than asked for before EOF, and treating
 * that as a truncated file would report a healthy transcript as gone. Returns
 * the count actually available. */
async function readFully(
  handle: fs.promises.FileHandle,
  buf: Buffer,
  position: number
): Promise<number> {
  let filled = 0
  while (filled < buf.length) {
    const { bytesRead } = await handle.read(buf, filled, buf.length - filled, position + filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  return filled
}

/**
 * Open the bytes a ref addresses.
 *
 * `undefined` means the ref provably no longer resolves — the row moved or
 * went, the span isn't the payload it named, the content changed — and the
 * route turns that into 410. Operational failures (EIO, EMFILE, EACCES, …)
 * throw instead: they say nothing about whether the media still exists, and
 * answering "permanently gone" to a transient disk problem strands the client
 * on a placeholder it will never retry.
 *
 * Validation is a handful of small reads, no scan: the row's uuid still sits
 * at the recorded offset; the payload is quote-delimited exactly as recorded;
 * its sampled fingerprint still matches; its head decodes to a known image
 * type. Only then is a stream opened.
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
  } catch (error) {
    // Only a missing transcript is "gone"; anything else is this machine
    // failing to answer a question about a file that may well be there.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let opened = false
  try {
    const stat = await handle.stat()
    const uuidEnd = ref.o + ref.u.length
    const payloadEnd = ref.s + ref.l
    if (stat.size < Math.max(uuidEnd, payloadEnd) + 1 || ref.o < 1 || ref.s < 1) return undefined

    // The row that owned this payload is still at the recorded offset.
    const uuidWindow = Buffer.allocUnsafe(ref.u.length + 2)
    if ((await readFully(handle, uuidWindow, ref.o - 1)) < uuidWindow.length) return undefined
    if (uuidWindow[0] !== QUOTE_BYTE || uuidWindow[uuidWindow.length - 1] !== QUOTE_BYTE) {
      return undefined
    }
    if (uuidWindow.subarray(1, uuidWindow.length - 1).toString('latin1') !== ref.u) return undefined

    signal?.throwIfAborted()
    // The payload is still exactly this JSON string: quote before it, and
    // quote right after its last byte.
    const openQuote = Buffer.allocUnsafe(1)
    if ((await readFully(handle, openQuote, ref.s - 1)) < 1) return undefined
    if (openQuote[0] !== QUOTE_BYTE) return undefined

    const closeQuote = Buffer.allocUnsafe(1)
    if ((await readFully(handle, closeQuote, payloadEnd)) < 1) return undefined
    if (closeQuote[0] !== QUOTE_BYTE) return undefined

    signal?.throwIfAborted()
    // Sampled content check, three small reads. The uuid pins the row; this
    // pins which image inside it, so a rewrite that slides a different payload
    // into this exact span fails here instead of serving the wrong picture.
    const { head, mid, tail, size } = sampleOffsets(ref.l)
    const windows: string[] = []
    for (const offset of [head, mid, tail]) {
      const buf = Buffer.allocUnsafe(size)
      if ((await readFully(handle, buf, ref.s + offset)) < size) return undefined
      windows.push(buf.toString('latin1'))
    }
    if (sampleFingerprint(windows[0]!, windows[1]!, windows[2]!, ref.l) !== ref.h) return undefined

    const pad = windows[2]!.endsWith('==') ? 2 : windows[2]!.endsWith('=') ? 1 : 0
    const headText = windows[0]!
    if (BASE64_INVALID.test(headText)) return undefined
    const usable = headText.length - (headText.length % 4)
    const mimeType = sniffImageType(Buffer.from(headText.slice(0, usable), 'base64'))
    if (!mimeType) return undefined

    signal?.throwIfAborted()
    const source = handle.createReadStream({ start: ref.s, end: payloadEnd - 1 })
    opened = true
    const decoded = createBase64DecodeStream()
    // pipeline(), not pipe(): pipe leaves the source running when the
    // destination is torn down (a cancelled response leaks this descriptor for
    // every abandoned image), and it does not forward source errors — an EIO
    // here would reach process-level uncaughtException, which this app answers
    // by shutting down. pipeline destroys both ends in either direction.
    pipeline(source, decoded, (error) => {
      if (error && !isBenignStreamError(error)) {
        console.error('Failed to stream session media:', error)
      }
    })
    // The request going away has to reach the file read too, not just the
    // socket — otherwise the disk work continues for a response nobody holds.
    if (signal) {
      const abort = () => decoded.destroy()
      signal.addEventListener('abort', abort, { once: true })
      decoded.once('close', () => signal.removeEventListener('abort', abort))
    }
    return { stream: decoded, mimeType, bytes: decodedLength(ref.l, pad) }
  } finally {
    // Nothing catches here on purpose: every "the ref no longer resolves" case
    // returns undefined explicitly above, so anything thrown is unexpected and
    // must reach the caller rather than be reported as "gone". The handle is
    // still released — the stream owns it once opened.
    if (!opened) await handle.close()
  }
}
