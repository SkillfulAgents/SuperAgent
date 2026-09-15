/**
 * Line and JSONL readers over `FileOps`, for transcripts.
 *
 * Each reader is the one it replaces with the file operations in place of the
 * filesystem calls: an open, a size, positional reads or a stream over the
 * handle. Lines are split in the raw bytes and never decoded or re-encoded,
 * so a consumer that copies them back out preserves the original bytes.
 * Only ASCII whitespace is trimmed at the byte level, and every such byte is
 * below 0x80, so a multi-byte UTF-8 sequence is never split.
 */
import { parseJsonlLine } from '@shared/lib/utils/file-storage'
import type { FileOps, OpenFile } from './types'
import { WorkspaceFileError } from './workspace-path'

const NEWLINE_BYTE = 0x0a
const TAIL_READ_CHUNK = 64 * 1024

/** True when the error says the file is not there. */
export function isAbsentFile(error: unknown): boolean {
  return error instanceof WorkspaceFileError && error.code === 'not-found'
}

/** The same bytes as a Buffer, without copying them. */
function asBuffer(chunk: Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
}

/**
 * A web stream's chunks as Buffers, one at a time. Ending the iteration early
 * cancels the stream, which releases whatever it reads from.
 */
export async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Buffer> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield asBuffer(value)
    }
  } finally {
    reader.releaseLock()
    await stream.cancel().catch(() => {})
  }
}

/**
 * A file's raw lines as byte buffers, split on `\n` (the newline byte is
 * excluded; a `\r` from a CRLF line is kept).
 *
 * `range` restricts the read to `[start, end)` byte offsets. `start` must be a
 * line boundary; a range ending mid-line yields the truncated head of that
 * line, which JSONL consumers drop as malformed.
 *
 * `signal` aborts between chunks (throws the abort reason): a per-line check
 * in the consumer is not enough, because a multi-MB row spans many chunks
 * before it ever yields. An absent file throws `not-found`.
 */
export async function* streamLines(
  files: FileOps,
  path: string,
  range?: { start?: number; end?: number },
  signal?: AbortSignal,
): AsyncIterable<Buffer> {
  signal?.throwIfAborted()
  if (range?.end !== undefined && range.end <= (range.start ?? 0)) return
  const file = await files.open(path)
  try {
    // The stream is the handle's last use and releases it when it ends; the
    // close below covers a consumer that stops early.
    const stream = file.stream(
      range?.start !== undefined || range?.end !== undefined
        ? { start: range.start ?? 0, ...(range.end !== undefined ? { end: range.end - 1 } : {}) }
        : undefined,
    )
    // Chunks holding the trailing, not-yet-terminated line. Concatenated only
    // once its newline arrives, so a row spanning many chunks is joined once.
    let pending: Buffer[] = []

    for await (const chunk of chunksOf(stream)) {
      signal?.throwIfAborted()
      let start = 0
      let idx = chunk.indexOf(NEWLINE_BYTE)
      while (idx !== -1) {
        if (pending.length > 0) {
          pending.push(chunk.subarray(start, idx))
          // Concat and release the source chunks BEFORE yielding: yield
          // suspends the generator, so anything still referenced here stays
          // reachable while the consumer holds the line.
          const line = Buffer.concat(pending)
          pending = []
          yield line
        } else {
          yield chunk.subarray(start, idx)
        }
        start = idx + 1
        idx = chunk.indexOf(NEWLINE_BYTE, start)
      }
      if (start < chunk.length) pending.push(chunk.subarray(start))
    }

    // An abort can arrive together with the stream's end, after the last
    // per-chunk check — observe it before paying for the concatenation of an
    // unterminated trailing row.
    signal?.throwIfAborted()
    if (pending.length > 0) {
      const line = Buffer.concat(pending)
      pending = []
      yield line
    }
  } finally {
    await file.close()
  }
}

/** Parsed JSONL entries in file order; blank and malformed lines are skipped. An absent file throws `not-found`. */
export async function* streamJsonl<T = unknown>(files: FileOps, path: string): AsyncIterable<T> {
  for await (const line of streamLines(files, path)) {
    const parsed = parseJsonlLine<T>(line)
    if (parsed !== undefined) yield parsed
  }
}

/** Every entry of a JSONL file, or `[]` when it is absent. */
export async function readJsonl<T = unknown>(files: FileOps, path: string): Promise<T[]> {
  const results: T[] = []
  try {
    for await (const item of streamJsonl<T>(files, path)) results.push(item)
  } catch (error) {
    if (isAbsentFile(error)) return []
    throw error
  }
  return results
}

/**
 * Open a file for the backward readers below: null when it is absent, which
 * they answer with "nothing", and the handle otherwise.
 */
async function openOrNull(files: FileOps, path: string): Promise<OpenFile | null> {
  try {
    return await files.open(path)
  } catch (error) {
    if (isAbsentFile(error)) return null
    throw error
  }
}

/**
 * The last `maxLines` JSONL rows, with each row's byte offset. Older rows are
 * never read into a line buffer.
 *
 * `signal` aborts the backward walk between chunk reads: transcripts run to
 * tens of MB and a caller whose HTTP client already hung up must be able to
 * stop paying for the rest of the file. Throws the abort reason.
 */
export async function readTailLines(
  files: FileOps,
  path: string,
  maxLines: number,
  signal?: AbortSignal,
): Promise<{ lines: Buffer[]; offsets: number[]; reachedStart: boolean }> {
  signal?.throwIfAborted()
  if (maxLines <= 0) return { lines: [], offsets: [], reachedStart: true }

  const file = await openOrNull(files, path)
  if (!file) return { lines: [], offsets: [], reachedStart: true }

  try {
    const size = await file.size()
    if (size === 0) return { lines: [], offsets: [], reachedStart: true }

    let pos = size
    const parts: Buffer[] = []
    let newlineCount = 0
    let truncated = false

    while (pos > 0 && newlineCount <= maxLines) {
      // Check BEFORE each read (an abort landing during open or a prior
      // iteration must not start another read) and AFTER it (an abort
      // landing while the FINAL chunk is in flight has no next iteration to
      // observe it, and would otherwise still pay for the line scan).
      signal?.throwIfAborted()
      const chunkSize = Math.min(TAIL_READ_CHUNK, pos)
      const chunkStart = pos - chunkSize
      const buf = asBuffer(await file.readAt(chunkStart, chunkSize, signal))
      signal?.throwIfAborted()
      if (buf.length < chunkSize) {
        // The file shrank while we walked it (rewrite race). Splicing a short
        // chunk against already-collected higher chunks would garble line
        // boundaries — stop here and serve only what was read cleanly.
        truncated = true
        break
      }
      // Only once the chunk is in hand: `pos` is the file offset that `parts`
      // starts at, and every returned offset is derived from it.
      pos = chunkStart
      parts.unshift(buf)
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === NEWLINE_BYTE) newlineCount++
      }
    }

    const combined = parts.length === 1 ? parts[0]! : Buffer.concat(parts)
    const lines: Buffer[] = []
    // Kept in lockstep with `lines` through every trim below, so consumers
    // that address into the file (media refs) can do so without a second pass.
    const offsets: number[] = []
    let start = 0
    for (let i = 0; i < combined.length; i++) {
      if (combined[i] === NEWLINE_BYTE) {
        lines.push(combined.subarray(start, i))
        offsets.push(pos + start)
        start = i + 1
      }
    }
    if (start < combined.length) {
      lines.push(combined.subarray(start))
      offsets.push(pos + start)
    }

    const reachedStart = pos === 0 && !truncated
    if (!reachedStart && lines.length > 0) {
      lines.shift()
      offsets.shift()
    }
    if (lines.length > 0 && lines[lines.length - 1]!.length === 0) {
      lines.pop()
      offsets.pop()
    }

    if (lines.length > maxLines) {
      return { lines: lines.slice(-maxLines), offsets: offsets.slice(-maxLines), reachedStart: false }
    }
    return { lines, offsets, reachedStart }
  } finally {
    await file.close()
  }
}

/**
 * A file's raw lines BACKWARD from the end without retaining the file. Yields
 * `{ line, offset }` per line — `offset` is the byte position of the line's
 * first byte; the newline is excluded from `line`. Memory held between
 * iterations is one read chunk plus the partial head of the line being
 * assembled, so walking an arbitrarily deep tail is O(chunk). Yielded
 * buffers may alias an internal read chunk: consume them within the
 * iteration, don't retain them.
 *
 * An absent file yields nothing. `signal` aborts between chunk reads (throws
 * the abort reason), the same contract as `readTailLines`.
 */
export async function* iterateLinesBackward(
  files: FileOps,
  path: string,
  signal?: AbortSignal,
): AsyncGenerator<{ line: Buffer; offset: number }> {
  signal?.throwIfAborted()
  const file = await openOrNull(files, path)
  if (!file) return

  try {
    let pos = await file.size()
    // Fragments (in file order) of the line whose start lies in a chunk not
    // yet read — the bytes below the lowest newline processed so far. Kept as
    // an array and concatenated ONCE at the line boundary: re-concatenating
    // per chunk would make a multi-chunk row cost O(rowBytes²) in copying.
    let carryParts: Buffer[] = []
    let carryBytes = 0
    // The first candidate is the region between the last newline and the end
    // — empty when the file ends with a newline. Skip only that empty
    // pseudo-line; interior empty lines are yielded (parseJsonlLine treats
    // them as blanks), matching readTailLines.
    let first = true

    while (pos > 0) {
      signal?.throwIfAborted()
      const chunkSize = Math.min(TAIL_READ_CHUNK, pos)
      pos -= chunkSize
      const buf = asBuffer(await file.readAt(pos, chunkSize, signal))
      signal?.throwIfAborted()
      if (buf.length < chunkSize) {
        // File shrank while we walked it (rewrite race): the bytes above were
        // read from the old layout, so stop instead of splicing garbage.
        return
      }

      // Unprocessed region of this chunk, scanned high-to-low.
      let high = buf.length
      let idx = high > 0 ? buf.lastIndexOf(NEWLINE_BYTE, high - 1) : -1
      while (idx !== -1) {
        const segment = buf.subarray(idx + 1, high)
        const line = carryParts.length > 0 ? Buffer.concat([segment, ...carryParts]) : segment
        carryParts = []
        carryBytes = 0
        if (line.length > 0 || !first) {
          yield { line, offset: pos + idx + 1 }
        }
        first = false
        high = idx
        idx = high > 0 ? buf.lastIndexOf(NEWLINE_BYTE, high - 1) : -1
      }
      if (high > 0) {
        carryParts.unshift(buf.subarray(0, high))
        carryBytes += high
      }
    }

    if (carryBytes > 0) {
      // Release the source fragments BEFORE yielding: the yield suspends the
      // generator, and holding both the fragments and their concatenation
      // would double the resident memory of exactly the oversized rows this
      // reader is sized for.
      const firstLine = Buffer.concat(carryParts)
      carryParts = []
      carryBytes = 0
      yield { line: firstLine, offset: 0 }
    }
  } finally {
    await file.close()
  }
}
