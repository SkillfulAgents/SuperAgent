import { afterEach, describe, expect, it, vi } from 'vitest'
import { strToU8, Zip, ZipDeflate, ZipPassThrough, zipSync } from 'fflate'
import { MAX_ZIP_BYTES } from '@renderer/lib/file-types'
import { downloadZip, listZip, MAX_ZIP_ENTRIES, unzipEntry } from './zip-archive'

const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])))
const text = (entry: ReturnType<typeof unzipEntry>) => (entry.ok ? new TextDecoder().decode(entry.content) : entry.reason)
/** Where the central directory's first record starts. */
const directory = (bytes: Uint8Array) => bytes.findIndex((_, i) => bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 1 && bytes[i + 3] === 2)

afterEach(() => vi.restoreAllMocks())

/** `a.md` holding "# A", stored, from yazl with `forceZip64Format`: its record's sizes and offset sit in a ZIP64 extra field. */
const ZIP64_RECORD = 'UEsDBBQAAAgAALqBVF0PdBVRAwAAAAMAAAAEAAAAYS5tZCMgQVBLAQI/Ay0AAAgAALqBVF0PdBVR//////////8EACUAAAAAAAAAAAC0gf////9hLm1kVVQFAAOx9ddqAQAYAAMAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAFBLBQYAAAAAAQABAFcAAAAlAAAAAAA='

/** `notes/a.md` holding "# Notes", from archiver with `forceZip64`: its end record defers to a ZIP64 one. */
const FORCED_ZIP64 = 'UEsDBBQACAAIAGS2VF0AAAAAAAAAAAAAAAAKAAAAbm90ZXMvYS5tZFNW8MsvSS0GAFBLBwjch21iCQAAAAcAAABQSwECLQMUAAgACABktlRd3IdtYgkAAAAHAAAACgAAAAAAAAAAACAApIEAAAAAbm90ZXMvYS5tZFBLBgYsAAAAAAAAAC0ALQAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAA4AAAAAAAAAEEAAAAAAAAAUEsGBwAAAAB5AAAAAAAAAAEAAABQSwUGAAAAAP///////////////wAA'

/**
 * A zip written as a stream: its local headers carry no sizes, only the trailing descriptors do. It may repeat a name.
 * Level 0 leaves the bytes raw, as zlib leaves data that does not compress.
 */
function streamedZip(files: [string, string | Uint8Array][], deflate = true): Uint8Array {
  const chunks: Uint8Array[] = []
  const out = new Zip((err, chunk) => {
    if (err) throw err
    chunks.push(chunk)
  })
  for (const [name, content] of files) {
    const file = deflate ? new ZipDeflate(name, { level: 0 }) : new ZipPassThrough(name)
    out.add(file)
    file.push(typeof content === 'string' ? strToU8(content) : content, true)
  }
  out.end()
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  chunks.reduce((at, chunk) => (bytes.set(chunk, at), at + chunk.byteLength), 0)
  return bytes
}

describe('listZip', () => {
  it('lists an entry it could not unpack, because listing never starts one', () => {
    const bytes = zip({ 'a.md': '# A' })
    bytes[directory(bytes) + 10] = 99 // the compression method: one this reader cannot inflate
    expect(listZip(bytes)).toEqual({ ok: true, names: ['a.md'] })
    expect(text(unzipEntry(bytes, 'a.md'))).toBe('unreadable')
  })

  it('stops past the entry limit, counting repeated names', () => {
    const repeated = streamedZip(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, () => ['same.txt', ''] as [string, string]), false)
    expect(listZip(repeated)).toEqual({ ok: false, reason: 'too-many' })
  })

  it('lists a nested zip in a streamed zip as one entry, not the entries inside it', () => {
    // Stored inside a deflate stream, the inner zip's headers appear raw, as a pptx's do when its images do not compress.
    let seed = 1
    const noise = Uint8Array.from({ length: 4096 }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24)
    const deck = zipSync({ 'ppt/media/image0.png': noise, 'ppt/media/image1.png': noise.slice().reverse() }, { level: 0 })
    const bytes = streamedZip([['Q3/deck.pptx', deck], ['Q3/notes.md', '# N']])
    expect(listZip(bytes)).toEqual({ ok: true, names: ['Q3/deck.pptx', 'Q3/notes.md'] })
    const opened = unzipEntry(bytes, 'Q3/deck.pptx')
    expect(opened.ok && opened.content).toEqual(deck)
  })

  it('reads names from the central directory for both listing and opening', () => {
    const bytes = zip({ 'a.md': '# A' })
    bytes[directory(bytes) + 46] = 'b'.charCodeAt(0) // the local header still says a.md
    expect(listZip(bytes)).toEqual({ ok: true, names: ['b.md'] })
    expect(text(unzipEntry(bytes, 'b.md'))).toBe('# A')
  })

  it('lists a repeated name once and opens the first, never both', () => {
    const bytes = streamedZip([['same.txt', 'FIRST'], ['same.txt', 'SECOND']])
    expect(listZip(bytes)).toEqual({ ok: true, names: ['same.txt'] })
    expect(text(unzipEntry(bytes, 'same.txt'))).toBe('FIRST')
  })

  it('splits names on either slash and drops empty, . and .. segments', () => {
    const bytes = zip({ 'reports\\q3\\summary.md': '', '/x': '', 'x/': '', 'a//b.md': '', './../up.md': '', '..': '' })
    expect(listZip(bytes)).toEqual({ ok: true, names: ['reports/q3/summary.md', 'x', 'x/', 'a/b.md', 'up.md'] })
  })

  it('reads a ZIP64 end record, as archiver writes with forceZip64', () => {
    const bytes = Uint8Array.from(atob(FORCED_ZIP64), c => c.charCodeAt(0))
    expect(listZip(bytes)).toEqual({ ok: true, names: ['notes/a.md'] })
    expect(text(unzipEntry(bytes, 'notes/a.md'))).toBe('# Notes')
  })

  it('reads sizes and offsets a record defers to its ZIP64 extra field, as yazl writes with forceZip64Format', () => {
    const bytes = Uint8Array.from(atob(ZIP64_RECORD), c => c.charCodeAt(0))
    expect(listZip(bytes)).toEqual({ ok: true, names: ['a.md'] })
    expect(text(unzipEntry(bytes, 'a.md'))).toBe('# A')
    bytes[98] = 8 // the ZIP64 field now holds one of the three values its record marks
    expect(listZip(bytes)).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('finds the end record past a comment that holds its signature', () => {
    const bytes = zip({ 'a.md': '' })
    // A whole end record: its comment ends the file, but it lists no directory where it stands.
    const comment = Uint8Array.of(0x50, 0x4b, 5, 6, ...new Array(18).fill(0))
    const commented = new Uint8Array(bytes.length + comment.length)
    commented.set(bytes)
    commented.set(comment, bytes.length)
    commented[bytes.length - 2] = comment.length
    expect(listZip(commented)).toEqual({ ok: true, names: ['a.md'] })
    commented.fill(0xff, commented.length - 10, commented.length - 6) // its directory size marked for ZIP64, with no ZIP64 record
    expect(listZip(commented)).toEqual({ ok: true, names: ['a.md'] })
  })

  it.each([
    ['a count past its records', (b: Uint8Array) => { b[b.length - 12] += 1 }],
    ['a directory offset past the end', (b: Uint8Array) => { b[b.length - 5] = 0x7f }],
    ['a record running past the directory', (b: Uint8Array) => { b[directory(b) + 32] = 0xff }],
  ])('calls a zip with %s unreadable', (_, corrupt) => {
    const bytes = zip({ 'a.md': '# A' })
    corrupt(bytes)
    expect(listZip(bytes)).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('reads a UTF-8 name without the UTF-8 flag, and falls back to Latin-1', () => {
    const utf8 = zip({ 'Résumé.md': '' })
    utf8[7] &= ~0x08 // the flag in the local header
    utf8[directory(utf8) + 9] &= ~0x08 // and in the central directory
    expect(listZip(utf8)).toEqual({ ok: true, names: ['Résumé.md'] })
    const latin1 = zip({ 'cafe.md': '' })
    latin1[directory(latin1) + 46 + 3] = 0xe9
    expect(listZip(latin1)).toEqual({ ok: true, names: ['café.md'] })
  })

  it('lists an empty zip as empty, and calls bytes that are not a zip, or an overlong name, unreadable', () => {
    expect(listZip(zip({}))).toEqual({ ok: true, names: [] })
    expect(listZip(zip({}).subarray(0, 4))).toEqual({ ok: false, reason: 'unreadable' })
    expect(listZip(strToU8('not a zip'))).toEqual({ ok: false, reason: 'unreadable' })
    expect(listZip(zip({ ['a/'.repeat(600)]: '' }))).toEqual({ ok: false, reason: 'unreadable' })
    expect(listZip(zip({ ['文'.repeat(400)]: '' }))).toEqual({ ok: true, names: ['文'.repeat(400)] })
  })
})

describe('downloadZip', () => {
  const body = (size: number) => new Response(new ReadableStream({
    start(controller) {
      for (let sent = 0; sent < size; sent += 1024 * 1024) controller.enqueue(new Uint8Array(Math.min(1024 * 1024, size - sent)))
      controller.close()
    },
  }))

  it('reads up to the limit and stops one byte past it', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    fetch.mockImplementation(async (_, init) => (init?.method === 'HEAD' ? new Response(null) : body(MAX_ZIP_BYTES)))
    expect((await downloadZip('/zip'))?.byteLength).toBe(MAX_ZIP_BYTES)
    fetch.mockImplementation(async (_, init) => (init?.method === 'HEAD' ? new Response(null) : body(MAX_ZIP_BYTES + 1)))
    expect(await downloadZip('/zip')).toBeNull()
  })

  it('stops at a HEAD length over the limit, and skips the HEAD for a zip unpacked from another', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => (init?.method === 'HEAD'
      ? new Response(null, { headers: { 'content-length': String(MAX_ZIP_BYTES + 1) } })
      : body(1)))
    expect(await downloadZip('/zip')).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((await downloadZip('blob:inner'))?.byteLength).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('unzipEntry', () => {
  it('opens one entry, including an empty one', () => {
    const bytes = zip({ 'a.md': '# A', 'empty.txt': '' })
    expect(text(unzipEntry(bytes, 'a.md'))).toBe('# A')
    expect(text(unzipEntry(bytes, 'empty.txt'))).toBe('')
  })

  it('stops a bomb at the limit, and a stored entry past it', () => {
    expect(text(unzipEntry(zip({ 'bomb.txt': 'x'.repeat(MAX_ZIP_BYTES + 1) }), 'bomb.txt'))).toBe('too-much')
    expect(text(unzipEntry(zipSync({ 'big.bin': new Uint8Array(MAX_ZIP_BYTES + 1) }, { level: 0 }), 'big.bin'))).toBe('too-much')
  })

  it('refuses an encrypted entry rather than returning its ciphertext', () => {
    const bytes = zip({ 'secret.txt': 'hunter2' })
    bytes[directory(bytes) + 8] |= 1
    expect(text(unzipEntry(bytes, 'secret.txt'))).toBe('encrypted')
  })

  it('opens what it lists in a streamed zip', () => {
    const bytes = streamedZip([['notes/a.md', '# A'], ['b.csv', 'x,y']])
    expect(listZip(bytes)).toEqual({ ok: true, names: ['notes/a.md', 'b.csv'] })
    expect(text(unzipEntry(bytes, 'b.csv'))).toBe('x,y')
  })

  it('calls a missing entry, an entry past the end, or bytes that are not a zip unreadable', () => {
    expect(text(unzipEntry(zip({ 'a.md': '' }), 'b.md'))).toBe('unreadable')
    const moved = zip({ 'a.md': '# A' })
    moved[directory(moved) + 43] = 0x7f // its local header offset
    expect(text(unzipEntry(moved, 'a.md'))).toBe('unreadable')
    const truncated = zip({ 'a.md': '# A'.repeat(100) })
    truncated[directory(truncated) + 20] -= 1 // its compressed size, one byte short
    expect(text(unzipEntry(truncated, 'a.md'))).toBe('unreadable')
    truncated.fill(0, directory(truncated) + 20, directory(truncated) + 24) // no compressed bytes at all
    expect(text(unzipEntry(truncated, 'a.md'))).toBe('unreadable')
    expect(text(unzipEntry(strToU8('not a zip'), 'a.md'))).toBe('unreadable')
  })
})
