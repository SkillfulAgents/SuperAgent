import { Unzip, UnzipInflate } from 'fflate'

/** The download limit and the per-file unpack limit: 5 MB as the drawer header counts sizes. */
export const MAX_ZIP_BYTES = 5 * 1024 * 1024

/** The most entries a listing reads, and the longest name, so a crafted directory cannot stall the drawer. */
export const MAX_ZIP_ENTRIES = 10_000
const MAX_ZIP_NAME = 1_024

export type ZipListing = { ok: true; names: string[] } | { ok: false; reason: 'too-many' | 'unreadable' }
export type ZipEntry = { ok: true; content: Uint8Array<ArrayBuffer> } | { ok: false; reason: 'too-much' | 'unreadable' }

// Each push inflates its whole slice before the counter sees it. Deflate expands at most
// ~1000x, so a 16 KB slice bounds one step to ~16 MB.
const SLICE = 16 * 1024

/** The response body, or null once it passes `maxBytes`. Counts as it streams, since a proxied response may carry no length. */
async function readWithin(res: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return concat(chunks, size)
}

function concat(chunks: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** The zip's bytes, or null past the limit. */
export async function downloadZip(url: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | null> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Failed to load file: ${res.status}`)
  return readWithin(res, MAX_ZIP_BYTES)
}

/** Feeds the zip to `unzip` a slice at a time until it ends or `stop` says so. */
function walk(unzip: Unzip, bytes: Uint8Array, stop: () => boolean) {
  for (let at = 0; at < bytes.length && !stop(); at += SLICE) {
    unzip.push(bytes.subarray(at, at + SLICE), at + SLICE >= bytes.length)
  }
}

/**
 * The entry names, read by the same walk `unzipEntry` uses, so the list never shows a file
 * that opening would read differently. Nothing is unpacked.
 */
export function listZip(bytes: Uint8Array): ZipListing {
  const names = new Set<string>()
  let seen = 0
  let tooLong = false
  const unzip = new Unzip(file => {
    seen += 1
    if (file.name.length > MAX_ZIP_NAME) tooLong = true
    else names.add(file.name)
  })
  try {
    walk(unzip, bytes, () => seen > MAX_ZIP_ENTRIES || tooLong)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (seen > MAX_ZIP_ENTRIES) return { ok: false, reason: 'too-many' }
  if (tooLong || (names.size === 0 && !isEmptyZip(bytes))) return { ok: false, reason: 'unreadable' }
  return { ok: true, names: [...names] }
}

/** A zip with no entries is only its 22-byte end record and its comment. fflate reads it, and anything that is not a zip, as no entries. */
function isEmptyZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x05 && bytes[3] === 0x06 && bytes.length === 22 + (bytes[20] | (bytes[21] << 8))
}

/** Unpacks one entry, counting as it inflates, and stops past the limit whatever size the zip claims. */
export function unzipEntry(bytes: Uint8Array, name: string): ZipEntry {
  const chunks: Uint8Array[] = []
  let size = 0
  let done = false
  let tooMuch = false
  const unzip = new Unzip(file => {
    if (file.name !== name || done) return
    file.ondata = (err, chunk, final) => {
      if (err) throw err
      size += chunk.byteLength
      if (size > MAX_ZIP_BYTES) {
        file.terminate()
        tooMuch = true
        return
      }
      chunks.push(chunk)
      done = final
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  try {
    walk(unzip, bytes, () => done || tooMuch)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (tooMuch) return { ok: false, reason: 'too-much' }
  return done ? { ok: true, content: concat(chunks, size) } : { ok: false, reason: 'unreadable' }
}
