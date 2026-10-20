import { Inflate } from 'fflate'
import { MAX_ZIP_BYTES } from '@renderer/lib/file-types'

/** The most entries a listing reads, and the longest name, so a crafted directory cannot stall the drawer. */
export const MAX_ZIP_ENTRIES = 10_000
const MAX_ZIP_NAME = 1_024

export type ZipListing = { ok: true; names: string[] } | { ok: false; reason: 'too-many' | 'unreadable' }
export type ZipEntry = { ok: true; content: Uint8Array<ArrayBuffer> } | { ok: false; reason: 'too-much' | 'encrypted' | 'unreadable' }

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
  const load = (method: 'HEAD' | 'GET') => fetch(url, { method, signal })
  // A HEAD keeps its length through the cloud proxy, which drops a GET's. A zip unpacked from another is already in memory and within the limit.
  if (!url.startsWith('blob:') && Number((await load('HEAD')).headers.get('content-length')) > MAX_ZIP_BYTES) return null
  const res = await load('GET')
  if (!res.ok) throw new Error(`Failed to load file: ${res.status}`)
  return readWithin(res, MAX_ZIP_BYTES)
}

interface ZipRecord {
  flags: number
  method: number
  compressedSize: number
  offset: number
}

const utf8 = new TextDecoder('utf-8', { fatal: true })
const latin1 = new TextDecoder('latin1')

/** UTF-8 when it decodes as UTF-8, whether or not the zip flags it, else Latin-1. */
function decodeName(raw: Uint8Array): string {
  try {
    return utf8.decode(raw)
  } catch {
    return latin1.decode(raw)
  }
}

/** One name per entry: either slash separates, empty, `.` and `..` segments go, as unzip drops them, and a folder keeps its trailing slash. */
function normalize(name: string): string {
  const path = name.split(/[\\/]/).filter(part => part && part !== '.' && part !== '..').join('/')
  return path && /[\\/]$/.test(name) ? `${path}/` : path
}

/** An end record whose comment ends the file and whose directory ends where it starts, or defers to a ZIP64 end record. */
function isEnd(view: DataView, at: number): boolean {
  if (view.getUint32(at, true) !== 0x06054b50 || at + 22 + view.getUint16(at + 20, true) !== view.byteLength) return false
  return view.getUint32(at + 16, true) + view.getUint32(at + 12, true) === at || (at >= 20 && view.getUint32(at - 20, true) === 0x07064b50)
}

/**
 * A record's compressed size and offset, taking any marked 0xffffffff from its ZIP64 extra
 * field, which holds the marked fields in order: size, compressed size, offset. Null when one is missing.
 */
function zip64Fields(view: DataView, at: number, next: number, record: ZipRecord): { compressedSize: number; offset: number } | null {
  const marked = [view.getUint32(at + 24, true), record.compressedSize, record.offset].map(field => field === 0xffffffff)
  if (!marked.includes(true)) return record
  const extraEnd = Math.min(at + 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true), next)
  for (let field = at + 46 + view.getUint16(at + 28, true); field + 4 <= extraEnd; field += 4 + view.getUint16(field + 2, true)) {
    if (view.getUint16(field, true) !== 1) continue
    const values: number[] = []
    for (let value = field + 4; value + 8 <= Math.min(field + 4 + view.getUint16(field + 2, true), extraEnd); value += 8) values.push(Number(view.getBigUint64(value, true)))
    if (values.length < marked.filter(Boolean).length) return null
    let i = marked[0] ? 1 : 0
    return { compressedSize: marked[1] ? values[i++] : record.compressedSize, offset: marked[2] ? values[i] : record.offset }
  }
  return null
}

/**
 * Every entry by name, from the central directory, the index a zip keeps at its end.
 * Listing and opening both read it, so the list never shows a file opening would read differently,
 * and bytes inside an entry are never taken for an entry. The first of a repeated name wins.
 */
function readDirectory(bytes: Uint8Array): Map<string, ZipRecord> | 'too-many' | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end record is the last 22 bytes before a comment of up to 64 KB.
  let end = bytes.length - 22
  while (end >= 0 && end >= bytes.length - 22 - 0xffff && !isEnd(view, end)) end -= 1
  if (end < 0 || end < bytes.length - 22 - 0xffff) return null
  let count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  // A ZIP64 end record, which some writers always add, holds the real count and offset.
  if ((count === 0xffff || at === 0xffffffff) && end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) {
    const zip64 = Number(view.getBigUint64(end - 12, true))
    if (zip64 + 56 > end || view.getUint32(zip64, true) !== 0x06064b50) return null
    count = Number(view.getBigUint64(zip64 + 32, true))
    at = Number(view.getBigUint64(zip64 + 48, true))
  }
  if (count > MAX_ZIP_ENTRIES) return 'too-many'
  const entries = new Map<string, ZipRecord>()
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) return null
    const nameLength = view.getUint16(at + 28, true)
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
    if (next > end) return null
    const decoded = decodeName(bytes.subarray(at + 46, at + 46 + nameLength))
    if (decoded.length > MAX_ZIP_NAME) return null
    const name = normalize(decoded)
    if (name && !entries.has(name)) {
      const record = { flags: view.getUint16(at + 8, true), method: view.getUint16(at + 10, true), compressedSize: view.getUint32(at + 20, true), offset: view.getUint32(at + 42, true) }
      const fields = zip64Fields(view, at, next, record)
      if (!fields) return null
      entries.set(name, { ...record, ...fields })
    }
    at = next
  }
  return entries
}

/** The entry names. Nothing is unpacked. */
export function listZip(bytes: Uint8Array): ZipListing {
  const entries = readDirectory(bytes)
  if (entries === 'too-many') return { ok: false, reason: 'too-many' }
  return entries ? { ok: true, names: [...entries.keys()] } : { ok: false, reason: 'unreadable' }
}

/** Unpacks one entry, counting as it inflates, and stops past the limit whatever size the zip claims. */
export function unzipEntry(bytes: Uint8Array, name: string): ZipEntry {
  const entries = readDirectory(bytes)
  const entry = entries instanceof Map ? entries.get(name) : undefined
  if (!entry) return { ok: false, reason: 'unreadable' }
  if (entry.flags & 1) return { ok: false, reason: 'encrypted' }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== 0x04034b50) return { ok: false, reason: 'unreadable' }
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (data.length < entry.compressedSize) return { ok: false, reason: 'unreadable' }
  if (entry.method === 0) return data.length > MAX_ZIP_BYTES ? { ok: false, reason: 'too-much' } : { ok: true, content: data.slice() }
  if (entry.method !== 8 || data.length === 0) return { ok: false, reason: 'unreadable' }

  const chunks: Uint8Array[] = []
  let size = 0
  const inflate = new Inflate(chunk => {
    size += chunk.byteLength
    if (size <= MAX_ZIP_BYTES) chunks.push(chunk)
  })
  try {
    for (let at = 0; at < data.length && size <= MAX_ZIP_BYTES; at += SLICE) {
      inflate.push(data.subarray(at, at + SLICE), at + SLICE >= data.length)
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  return size > MAX_ZIP_BYTES ? { ok: false, reason: 'too-much' } : { ok: true, content: concat(chunks, size) }
}
