import { describe, expect, it, vi } from 'vitest'
import { strToU8, Zip, ZipDeflate, ZipPassThrough, zipSync } from 'fflate'
import { downloadZip, listZip, MAX_ZIP_BYTES, MAX_ZIP_ENTRIES, unzipEntry } from './zip-archive'

const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])))
const text = (entry: ReturnType<typeof unzipEntry>) => (entry.ok ? new TextDecoder().decode(entry.content) : entry.reason)

/** A zip written as a stream: its local headers carry no sizes, only the trailing descriptors do. It may repeat a name. */
function streamedZip(files: [string, string][], deflate = true): Uint8Array {
  const chunks: Uint8Array[] = []
  const out = new Zip((err, chunk) => {
    if (err) throw err
    chunks.push(chunk)
  })
  for (const [name, content] of files) {
    const file = deflate ? new ZipDeflate(name) : new ZipPassThrough(name)
    out.add(file)
    file.push(strToU8(content), true)
  }
  out.end()
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  chunks.reduce((at, chunk) => (bytes.set(chunk, at), at + chunk.byteLength), 0)
  return bytes
}

describe('listZip', () => {
  it('lists an entry it could not unpack, because listing never starts one', () => {
    const bytes = zip({ 'a.md': '# A' })
    bytes[8] = 99 // the local header's compression method: one fflate cannot inflate
    expect(listZip(bytes)).toEqual({ ok: true, names: ['a.md'] })
    expect(text(unzipEntry(bytes, 'a.md'))).toBe('unreadable')
  })

  it('stops past the entry limit, counting repeated names', () => {
    const repeated = streamedZip(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, () => ['same.txt', ''] as [string, string]), false)
    expect(listZip(repeated)).toEqual({ ok: false, reason: 'too-many' })
  })

  it('reads names the way opening does, not from the index a crafted zip can disagree with', () => {
    const bytes = zip({ 'a.md': '# A' })
    const index = bytes.findIndex((_, i) => bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 1 && bytes[i + 3] === 2)
    bytes[index + 46] = 'b'.charCodeAt(0) // the central directory now names it b.md
    expect(listZip(bytes)).toEqual({ ok: true, names: ['a.md'] })
    expect(text(unzipEntry(bytes, 'a.md'))).toBe('# A')
  })

  it('lists an empty zip as empty, and calls bytes that are not a zip, or an overlong name, unreadable', () => {
    expect(listZip(zip({}))).toEqual({ ok: true, names: [] })
    expect(listZip(zip({}).subarray(0, 4))).toEqual({ ok: false, reason: 'unreadable' })
    expect(listZip(strToU8('not a zip'))).toEqual({ ok: false, reason: 'unreadable' })
    expect(listZip(zip({ ['a/'.repeat(600)]: '' }))).toEqual({ ok: false, reason: 'unreadable' })
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
    fetch.mockResolvedValueOnce(body(MAX_ZIP_BYTES))
    expect((await downloadZip('/zip'))?.byteLength).toBe(MAX_ZIP_BYTES)
    fetch.mockResolvedValueOnce(body(MAX_ZIP_BYTES + 1))
    expect(await downloadZip('/zip')).toBeNull()
    fetch.mockRestore()
  })
})

describe('unzipEntry', () => {
  it('opens one entry, including an empty one', () => {
    const bytes = zip({ 'a.md': '# A', 'empty.txt': '' })
    expect(text(unzipEntry(bytes, 'a.md'))).toBe('# A')
    expect(text(unzipEntry(bytes, 'empty.txt'))).toBe('')
  })

  it('stops a bomb at the limit', () => {
    expect(text(unzipEntry(zip({ 'bomb.txt': 'x'.repeat(MAX_ZIP_BYTES + 1) }), 'bomb.txt'))).toBe('too-much')
  })

  it('opens what it lists in a streamed zip', () => {
    const bytes = streamedZip([['notes/a.md', '# A'], ['b.csv', 'x,y']])
    expect(listZip(bytes)).toEqual({ ok: true, names: ['notes/a.md', 'b.csv'] })
    expect(text(unzipEntry(bytes, 'b.csv'))).toBe('x,y')
  })

  it('calls a missing entry or bytes that are not a zip unreadable', () => {
    expect(text(unzipEntry(zip({ 'a.md': '' }), 'b.md'))).toBe('unreadable')
    expect(text(unzipEntry(strToU8('not a zip'), 'a.md'))).toBe('unreadable')
  })
})
