import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import yazl from 'yazl'
import { openZipFromBuffer, openZipFromFile, ZipExtractionSizeError } from './zip'
import type { ZipReader } from './zip'

const tempDirs: string[] = []
const readers: ZipReader[] = []

afterEach(() => {
  for (const reader of readers.splice(0)) reader.close()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

// Large enough that a file-backed entry must perform several reads, including
// with DEFLATE. A repeated-byte fixture can be read in full before cancellation.
const payload = Buffer.alloc(512 * 1024)
let seed = 0x12345678
for (let i = 0; i < payload.length; i++) {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  payload[i] = seed & 0xff
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function archive(compress: boolean): Promise<Buffer> {
  const zip = new yazl.ZipFile()
  zip.addBuffer(payload, 'large.bin', { compress })
  zip.addBuffer(Buffer.from('healthy sibling'), 'sibling.txt', { compress })
  zip.end()
  return collect(zip.outputStream)
}

function openFds(filePath: string): number {
  let count = 0
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    try {
      if (fs.readlinkSync(`/proc/self/fd/${fd}`) === filePath) count++
    } catch {
      // An unrelated descriptor may close between listing and reading it.
    }
  }
  return count
}

async function fixture(source: 'buffer' | 'file', bytes: Buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-lifecycle-'))
  tempDirs.push(dir)
  const archivePath = path.join(dir, 'archive.zip')
  fs.writeFileSync(archivePath, bytes)
  const reader = source === 'file' ? await openZipFromFile(archivePath) : await openZipFromBuffer(bytes)
  readers.push(reader)
  // Assert the descriptor exists first, so a broken /proc check cannot make
  // the later leak check pass vacuously. Other OSes still run all stream checks.
  if (source === 'file' && process.platform === 'linux') {
    expect(openFds(archivePath)).toBe(1)
  }
  return {
    reader,
    dir,
    archivePath,
    async closeAndCheck() {
      reader.close()
      reader.close() // Explicit close remains safe after an operation failed.
      if (source === 'file' && process.platform === 'linux') {
        await expect.poll(() => openFds(archivePath), { timeout: 2000 }).toBe(0)
      }
    },
  }
}

describe.each(['buffer', 'file'] as const)('%s-backed ZIP lifecycle', (source) => {
  describe.each([
    { compression: 'stored', compress: false },
    { compression: 'deflated', compress: true },
  ])('$compression entries', ({ compress }) => {
    it('releases a size-limited read without interrupting a concurrent sibling', async () => {
      const { reader, closeAndCheck } = await fixture(source, await archive(compress))
      const [large, sibling] = await Promise.allSettled([
        reader.readEntry('large.bin', 8192),
        reader.readEntry('sibling.txt'),
      ])
      expect(large).toMatchObject({ status: 'rejected', reason: { name: 'ZipExtractionSizeError', limit: 8192 } })
      expect(sibling).toEqual({ status: 'fulfilled', value: Buffer.from('healthy sibling') })
      // The same entry can still be read after its previous stream was aborted.
      expect((await reader.readEntry('large.bin', payload.length)).equals(payload)).toBe(true)
      await closeAndCheck()
    })

    it('closes a limited stream and the archive after the size error', async () => {
      const { reader, closeAndCheck } = await fixture(source, await archive(compress))
      const stream = await reader.openEntryStream('large.bin', 8192)
      await expect(collect(stream)).rejects.toBeInstanceOf(ZipExtractionSizeError)
      await expect.poll(() => stream.closed).toBe(true)
      expect(await reader.readEntry('sibling.txt')).toEqual(Buffer.from('healthy sibling'))
      await closeAndCheck()
    })

    it('removes a partially written extraction after exceeding the byte limit', async () => {
      const { reader, dir, closeAndCheck } = await fixture(source, await archive(compress))
      const dest = path.join(dir, 'partial.bin')
      // Permit several chunks to be written before the failure, not only the
      // first chunk, to exercise a real partially written file and backpressure.
      await expect(reader.extractEntry('large.bin', dest, 128 * 1024)).rejects.toBeInstanceOf(ZipExtractionSizeError)
      await expect.poll(() => fs.existsSync(dest)).toBe(false)
      expect(await reader.readEntry('sibling.txt')).toEqual(Buffer.from('healthy sibling'))
      await closeAndCheck()
    })

    for (const limited of [false, true]) {
      const streamKind = limited ? 'limited' : 'raw'

      it(`finishes a ${streamKind} async iterator and releases its descriptor`, async () => {
        const { reader, closeAndCheck } = await fixture(source, await archive(compress))
        const stream = await reader.openEntryStream('large.bin', limited ? payload.length : undefined)
        expect((await collect(stream)).equals(payload)).toBe(true)
        await expect.poll(() => stream.closed).toBe(true)
        await closeAndCheck()
      })

      it(`allows early exit from a ${streamKind} async iterator without hanging`, async () => {
        const { reader, closeAndCheck } = await fixture(source, await archive(compress))
        const stream = await reader.openEntryStream('large.bin', limited ? payload.length : undefined)
        let received = 0
        for await (const chunk of stream) {
          received += (chunk as Buffer).length
          break
        }
        expect(received).toBeGreaterThan(0)
        if (source === 'file' || compress) expect(received).toBeLessThan(payload.length)
        await expect.poll(() => stream.closed).toBe(true)
        expect(await reader.readEntry('sibling.txt')).toEqual(Buffer.from('healthy sibling'))
        await closeAndCheck()
      })

      it(`closes a ${streamKind} stream destroyed before consumption without a spurious error`, async () => {
        const { reader, closeAndCheck } = await fixture(source, await archive(compress))
        const stream = await reader.openEntryStream('large.bin', limited ? payload.length : undefined)
        const errors: Error[] = []
        stream.on('error', (err: Error) => errors.push(err))
        stream.destroy()
        await expect.poll(() => stream.closed).toBe(true)
        expect(errors).toEqual([])
        await closeAndCheck()
      })
    }
  })

  describe('corrupt DEFLATE data', () => {
    async function corruptArchive() {
      const bytes = await archive(true)
      // First local header: filename length at 26, extra length at 28, then
      // compressed data at 30 + those lengths. BTYPE=3 is invalid DEFLATE.
      expect(bytes.readUInt32LE(0)).toBe(0x04034b50)
      const dataStart = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28)
      bytes[dataStart] = (bytes[dataStart] & 0xf9) | 0x06
      return fixture(source, bytes)
    }

    it('rejects a failed read while allowing its healthy sibling to finish and the archive to close', async () => {
      const { reader, closeAndCheck } = await corruptArchive()
      const [bad, good] = await Promise.allSettled([
        reader.readEntry('large.bin'),
        reader.readEntry('sibling.txt'),
      ])
      expect(bad).toMatchObject({ status: 'rejected', reason: { code: 'Z_DATA_ERROR' } })
      expect(good).toEqual({ status: 'fulfilled', value: Buffer.from('healthy sibling') })
      await closeAndCheck()
    })

    it('propagates corruption through a limited stream and closes it', async () => {
      const { reader, closeAndCheck } = await corruptArchive()
      const stream = await reader.openEntryStream('large.bin', payload.length)
      await expect(collect(stream)).rejects.toMatchObject({ code: 'Z_DATA_ERROR' })
      await expect.poll(() => stream.closed).toBe(true)
      await closeAndCheck()
    })

    it('removes the output of a corrupt extraction and releases the archive', async () => {
      const { reader, dir, closeAndCheck } = await corruptArchive()
      const dest = path.join(dir, 'corrupt.bin')
      await expect(reader.extractEntry('large.bin', dest)).rejects.toMatchObject({ code: 'Z_DATA_ERROR' })
      await expect.poll(() => fs.existsSync(dest)).toBe(false)
      await closeAndCheck()
    })

    it('removes bytes already written when the final uncompressed-size check fails', async () => {
      const bytes = await archive(true)
      const centralHeader = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
      expect(centralHeader).toBeGreaterThan(-1)
      // Advertise one extra byte. DEFLATE remains valid and writes the whole
      // entry before yauzl detects the missing byte at EOF.
      bytes.writeUInt32LE(payload.length + 1, centralHeader + 24)
      const { reader, dir, closeAndCheck } = await fixture(source, bytes)
      const dest = path.join(dir, 'incomplete.bin')
      await expect(reader.extractEntry('large.bin', dest)).rejects.toThrow(/not enough bytes/)
      await expect.poll(() => fs.existsSync(dest)).toBe(false)
      await closeAndCheck()
    })
  })

  it('rejects a destination write failure and releases the archive', async () => {
    const { reader, dir, closeAndCheck } = await fixture(source, await archive(true))
    const missingParent = path.join(dir, 'missing', 'out.bin')
    await expect(reader.extractEntry('large.bin', missingParent)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fs.existsSync(missingParent)).toBe(false)
    await closeAndCheck()
  })
})

describe('file-backed entry I/O failures', () => {
  it.each([false, true])('propagates unexpected EOF and closes the archive (limited=%s)', async (limited) => {
    const { reader, archivePath, closeAndCheck } = await fixture('file', await archive(true))
    const stream = await reader.openEntryStream('large.bin', limited ? payload.length : undefined)
    // The central directory and local header were read successfully. Removing
    // the payload now exercises an actual zero-byte fs.read during streaming.
    fs.truncateSync(archivePath, 0)
    await expect(collect(stream)).rejects.toMatchObject({ code: 'Z_BUF_ERROR' })
    await expect.poll(() => stream.closed).toBe(true)
    await closeAndCheck()
  })
})
