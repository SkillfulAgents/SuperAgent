import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  MEDIA_INLINE_MAX_BYTES,
  decodeMediaRef,
  encodeMediaRef,
  imageDimensions,
  openMediaBlob,
  replaceInlineMediaWithRefs,
  type MediaRefBlock,
} from './session-media'
import { getSessionMessagesPage, getSessionMessagesDelta } from './session-service'
import type { JsonlEntry } from '@shared/lib/types/agent'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

/** An image big enough to be worth a ref. Only the magic number is inspected,
 * so deterministic filler keeps the fixtures readable. */
function fakeImage(magic: Buffer, size: number, fill = 0xab): Buffer {
  return Buffer.concat([magic, Buffer.alloc(size - magic.length, fill)])
}

const BIG_PNG = fakeImage(PNG_MAGIC, 40 * 1024)
const BIG_JPEG = fakeImage(JPEG_MAGIC, 24 * 1024, 0x5c)
const SMALL_PNG = fakeImage(PNG_MAGIC, 1024)

function imageBlock(bytes: Buffer, mediaType = 'image/png') {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } }
}

function toolResultEntry(uuid: string, toolUseId: string, blocks: unknown[], extra: object = {}) {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: blocks }] },
    ...extra,
  }
}

function assistantWithToolUse(uuid: string, toolUseId: string) {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      id: `msg-${uuid}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: '/shot.png' } }],
    },
  }
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

describe('session-media', () => {
  let testDir: string
  let originalEnv: string | undefined

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'session-media-test-'))
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
  })

  afterEach(async () => {
    if (originalEnv) process.env.SUPERAGENT_DATA_DIR = originalEnv
    else delete process.env.SUPERAGENT_DATA_DIR
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  /** Write entries as JSONL and return the path plus each row's byte offset. */
  async function writeJsonl(entries: object[]): Promise<{ file: string; offsets: number[] }> {
    const file = path.join(testDir, 'transcript.jsonl')
    const offsets: number[] = []
    let body = ''
    for (const entry of entries) {
      offsets.push(Buffer.byteLength(body))
      body += JSON.stringify(entry) + '\n'
    }
    await fs.promises.writeFile(file, body)
    return { file, offsets }
  }

  /** Strip one row the way a read path does, returning the mutated entry. */
  async function stripRow(entries: object[], index: number): Promise<{ entry: JsonlEntry; file: string }> {
    const { file, offsets } = await writeJsonl(entries)
    const raw = await fs.promises.readFile(file)
    const line = raw.subarray(offsets[index], raw.indexOf(0x0a, offsets[index]))
    const entry = JSON.parse(line.toString('utf-8')) as JsonlEntry
    replaceInlineMediaWithRefs(entry, { line, lineOffset: offsets[index]! })
    return { entry, file }
  }

  function refsIn(entry: JsonlEntry): MediaRefBlock[] {
    const content = (entry as unknown as { message: { content: unknown[] } }).message.content
    const out: MediaRefBlock[] = []
    for (const block of content) {
      const b = block as { type: string; content?: unknown[] }
      if (b.type === 'media_ref') out.push(b as unknown as MediaRefBlock)
      if (Array.isArray(b.content)) {
        for (const inner of b.content) {
          if ((inner as { type: string }).type === 'media_ref') out.push(inner as MediaRefBlock)
        }
      }
    }
    return out
  }

  describe('ref minting', () => {
    it('replaces a tool-result image with a ref that resolves to the same bytes', async () => {
      const { entry, file } = await stripRow(
        [toolResultEntry('u-1', 'tool-1', [{ type: 'text', text: 'here' }, imageBlock(BIG_PNG)])],
        0
      )

      const refs = refsIn(entry)
      expect(refs).toHaveLength(1)
      expect(refs[0]!.mimeType).toBe('image/png')
      expect(refs[0]!.bytes).toBe(BIG_PNG.length)
      // No URL on the wire: the client builds it from trusted session context.
      expect(refs[0] as unknown as Record<string, unknown>).not.toHaveProperty('url')
      // The text block beside it is untouched.
      const inner = (entry as unknown as { message: { content: Array<{ content: unknown[] }> } })
        .message.content[0]!.content
      expect(inner[0]).toEqual({ type: 'text', text: 'here' })

      const blob = await openMediaBlob(file, decodeMediaRef(refs[0]!.id)!)
      expect(blob).toBeDefined()
      expect(blob!.mimeType).toBe('image/png')
      expect(blob!.bytes).toBe(BIG_PNG.length)
      expect((await collectStream(blob!.stream)).equals(BIG_PNG)).toBe(true)
    })

    it('keeps images below the inline threshold inline', async () => {
      expect(SMALL_PNG.length).toBeLessThan(MEDIA_INLINE_MAX_BYTES)
      const { entry } = await stripRow([toolResultEntry('u-1', 'tool-1', [imageBlock(SMALL_PNG)])], 0)
      expect(refsIn(entry)).toHaveLength(0)
      const inner = (
        entry as unknown as { message: { content: Array<{ content: Array<{ type: string }> }> } }
      ).message.content[0]!.content
      expect(inner[0]!.type).toBe('image')
    })

    it('gives repeated copies of one image distinct spans', async () => {
      const { entry, file } = await stripRow(
        [toolResultEntry('u-1', 'tool-1', [imageBlock(BIG_PNG), imageBlock(BIG_PNG)])],
        0
      )
      const refs = refsIn(entry)
      expect(refs).toHaveLength(2)
      const first = decodeMediaRef(refs[0]!.id)!
      const second = decodeMediaRef(refs[1]!.id)!
      expect(second.s).toBeGreaterThan(first.s)
      // Both still serve the image.
      for (const ref of [first, second]) {
        const blob = await openMediaBlob(file, ref)
        expect((await collectStream(blob!.stream)).equals(BIG_PNG)).toBe(true)
      }
    })

    it('handles the MCP image shape and non-png types', async () => {
      const { entry, file } = await stripRow(
        [
          toolResultEntry('u-1', 'tool-1', [
            { type: 'image', data: BIG_JPEG.toString('base64'), mimeType: 'image/jpeg' },
          ]),
        ],
        0
      )
      const refs = refsIn(entry)
      expect(refs).toHaveLength(1)
      expect(refs[0]!.mimeType).toBe('image/jpeg')
      const blob = await openMediaBlob(file, decodeMediaRef(refs[0]!.id)!)
      expect(blob!.mimeType).toBe('image/jpeg')
      expect((await collectStream(blob!.stream)).equals(BIG_JPEG)).toBe(true)
    })

    it('drops the duplicate copy the SDK writes under toolUseResult', async () => {
      const { entry } = await stripRow(
        [
          toolResultEntry('u-1', 'tool-1', [imageBlock(BIG_PNG)], {
            toolUseResult: { type: 'image', file: { base64: BIG_PNG.toString('base64'), type: 'image/png' } },
          }),
        ],
        0
      )
      const file = (entry as unknown as { toolUseResult: { file: Record<string, unknown> } })
        .toolUseResult.file
      expect(file.base64).toBeUndefined()
      expect(file.type).toBe('image/png')
    })

    it('mints refs for a row whose payload it can locate, and leaves others alone', async () => {
      // A row with no uuid cannot be validated on read, so nothing is minted.
      const { entry } = await stripRow(
        [
          {
            type: 'user',
            timestamp: '2026-01-01T00:00:00.000Z',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [imageBlock(BIG_PNG)] }] },
          },
        ],
        0
      )
      expect(refsIn(entry)).toHaveLength(0)
    })

    it('addresses a row that is not the first in the file', async () => {
      const { entry, file } = await stripRow(
        [
          assistantWithToolUse('a-0', 'tool-0'),
          toolResultEntry('u-0', 'tool-0', [imageBlock(BIG_JPEG, 'image/jpeg')]),
          toolResultEntry('u-1', 'tool-1', [imageBlock(BIG_PNG)]),
        ],
        2
      )
      const refs = refsIn(entry)
      expect(refs).toHaveLength(1)
      const blob = await openMediaBlob(file, decodeMediaRef(refs[0]!.id)!)
      expect((await collectStream(blob!.stream)).equals(BIG_PNG)).toBe(true)
    })
  })

  describe('ref validity', () => {
    async function mintOne(): Promise<{ id: string; file: string }> {
      const { entry, file } = await stripRow(
        [toolResultEntry('u-1', 'tool-1', [imageBlock(BIG_PNG)])],
        0
      )
      return { id: refsIn(entry)[0]!.id, file }
    }

    it('rejects a ref whose row has moved', async () => {
      const { id, file } = await mintOne()
      const original = await fs.promises.readFile(file)
      await fs.promises.writeFile(file, Buffer.concat([Buffer.from('{"type":"x"}\n'), original]))
      expect(await openMediaBlob(file, decodeMediaRef(id)!)).toBeUndefined()
    })

    it('rejects a ref whose payload survived but whose row is now a different one', async () => {
      // The case the recorded uuid offset exists for: a rewrite leaves a valid
      // image payload at the same span, so every structural check still
      // passes, but the row that owned it is gone. Swapping in a same-length
      // uuid reproduces that without disturbing a single offset.
      const { id, file } = await mintOne()
      const raw = await fs.promises.readFile(file)
      const rewritten = Buffer.from(raw.toString('latin1').replace('"uuid":"u-1"', '"uuid":"u-9"'), 'latin1')
      expect(rewritten.length).toBe(raw.length)
      await fs.promises.writeFile(file, rewritten)

      const ref = decodeMediaRef(id)!
      // The payload itself is untouched — only the identity check can catch this.
      expect(rewritten.subarray(ref.s, ref.s + 8).toString('latin1')).toBe(
        raw.subarray(ref.s, ref.s + 8).toString('latin1')
      )
      expect(await openMediaBlob(file, ref)).toBeUndefined()
    })

    it('rejects a ref whose row was deleted', async () => {
      const { id, file } = await mintOne()
      await fs.promises.writeFile(file, '{"type":"system","uuid":"s-1"}\n')
      expect(await openMediaBlob(file, decodeMediaRef(id)!)).toBeUndefined()
    })

    it('rejects a span that is not a quote-delimited payload', async () => {
      const { id, file } = await mintOne()
      const ref = decodeMediaRef(id)!
      expect(await openMediaBlob(file, { ...ref, s: ref.s + 4 })).toBeUndefined()
      expect(await openMediaBlob(file, { ...ref, l: ref.l - 4 })).toBeUndefined()
    })

    it('rejects a span whose content is not an image', async () => {
      // A long text field elsewhere in the row: quote-delimited, but its head
      // carries no image magic number.
      const text = 'A'.repeat(4096)
      const { entry, file } = await stripRow(
        [toolResultEntry('u-1', 'tool-1', [{ type: 'text', text }, imageBlock(BIG_PNG)])],
        0
      )
      const raw = await fs.promises.readFile(file)
      const at = raw.indexOf(text, 0, 'latin1')
      const ref = decodeMediaRef(refsIn(entry)[0]!.id)!
      expect(await openMediaBlob(file, { ...ref, s: at, l: text.length })).toBeUndefined()
    })

    it('rejects malformed and out-of-range refs', async () => {
      const { id, file } = await mintOne()
      expect(decodeMediaRef('not-base64url!!')).toBeUndefined()
      expect(decodeMediaRef(Buffer.from('{"v":2}').toString('base64url'))).toBeUndefined()
      expect(decodeMediaRef(Buffer.from('not json').toString('base64url'))).toBeUndefined()
      const ref = decodeMediaRef(id)!
      expect(await openMediaBlob(file, { ...ref, s: 10 ** 9 })).toBeUndefined()
      expect(await openMediaBlob(file, { ...ref, o: 10 ** 9 })).toBeUndefined()
    })

    it('takes the served type from the bytes, not from the ref', async () => {
      // The ref carries no type at all — a caller cannot dictate how bytes are
      // interpreted, which is what keeps forged spans harmless.
      const { entry, file } = await stripRow(
        [toolResultEntry('u-1', 'tool-1', [imageBlock(BIG_JPEG, 'image/png')])],
        0
      )
      const blob = await openMediaBlob(file, decodeMediaRef(refsIn(entry)[0]!.id)!)
      expect(blob!.mimeType).toBe('image/jpeg')
    })

    it('returns undefined for a missing transcript', async () => {
      const ref = { v: 1 as const, u: 'u-1', o: 10, s: 20, l: 40, h: 'abc' }
      expect(await openMediaBlob(path.join(testDir, 'gone.jsonl'), ref)).toBeUndefined()
    })

    it('round-trips a ref through its encoding', () => {
      const ref = { v: 1 as const, u: 'abc-123', o: 42, s: 4096, l: 8192, h: 'fp' }
      expect(decodeMediaRef(encodeMediaRef(ref))).toEqual(ref)
    })
  })


  // Each of these reproduces a defect found in review; they fail against the
  // code as it was when the reference scheme was first written.
  describe('review regressions', () => {
    it('does not mint a ref for a format the endpoint cannot serve', async () => {
      // Sniffing recognizes raster signatures only, so an SVG ref could never
      // be served — it must stay inline rather than become a dead image.
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg">' + '<rect/>'.repeat(4000) + '</svg>'
      )
      expect(svg.length).toBeGreaterThan(MEDIA_INLINE_MAX_BYTES)
      const { entry } = await stripRow(
        [toolResultEntry('u-1', 'tool-1', [imageBlock(svg, 'image/svg+xml')])],
        0
      )
      expect(refsIn(entry)).toHaveLength(0)
      const inner = (
        entry as unknown as { message: { content: Array<{ content: Array<{ type: string }> }> } }
      ).message.content[0]!.content
      expect(inner[0]!.type).toBe('image')
    })

    it('skips a textual copy of the payload and addresses the real field', async () => {
      // The same base64 inside a text block is not a quote-delimited field of
      // its own; minting there yields a ref that fails its own validation.
      const image = fakeImage(PNG_MAGIC, 30 * 1024, 0xcd)
      const { entry, file } = await stripRow(
        [
          toolResultEntry('u-1', 'tool-1', [
            { type: 'text', text: `copy=${image.toString('base64')};end` },
            imageBlock(image),
          ]),
        ],
        0
      )
      const refs = refsIn(entry)
      expect(refs).toHaveLength(1)
      const blob = await openMediaBlob(file, decodeMediaRef(refs[0]!.id)!)
      expect(blob).toBeDefined()
      expect((await collectStream(blob!.stream)).equals(image)).toBe(true)
    })

    it('refuses to serve a different image that moved into the same span', async () => {
      // Deleting the first of two images in one row slides the second into the
      // first's exact bytes with the row uuid untouched, so only content
      // identity can tell them apart.
      const first = fakeImage(PNG_MAGIC, 30 * 1024, 0x11)
      const second = fakeImage(PNG_MAGIC, 30 * 1024, 0x22)
      const { entry, file } = await stripRow(
        [toolResultEntry('u-1', 'tool-1', [imageBlock(first), imageBlock(second)])],
        0
      )
      const refFirst = decodeMediaRef(refsIn(entry)[0]!.id)!

      const rewritten = JSON.stringify(toolResultEntry('u-1', 'tool-1', [imageBlock(second)]))
      await fs.promises.writeFile(file, rewritten + '\n')

      expect(await openMediaBlob(file, refFirst)).toBeUndefined()
    })

    it('reports an exact integer size for unpadded base64', async () => {
      const image = fakeImage(PNG_MAGIC, 20 * 1024, 0x33)
      const unpadded = image.toString('base64').replace(/=+$/, '')
      const { entry, file } = await stripRow(
        [
          toolResultEntry('u-1', 'tool-1', [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: unpadded } },
          ]),
        ],
        0
      )
      const refs = refsIn(entry)
      expect(refs).toHaveLength(1)
      expect(Number.isInteger(refs[0]!.bytes)).toBe(true)
      const blob = await openMediaBlob(file, decodeMediaRef(refs[0]!.id)!)
      expect(Number.isInteger(blob!.bytes)).toBe(true)
      const served = await collectStream(blob!.stream)
      // The advertised length is what a Content-Length header promises.
      expect(blob!.bytes).toBe(served.length)
      expect(served.equals(image)).toBe(true)
    })


    it('refuses an equal-length image that differs outside any sampled window', async () => {
      // A digest over part of the payload would pass here: these two differ
      // only in a region no sample covers. The address is advertised as
      // immutable, so it has to name the bytes exactly.
      const bmp = (fill: number) => {
        const size = 30_054
        const b = Buffer.alloc(size, 0xaa)
        b[0] = 0x42
        b[1] = 0x4d // "BM"
        b.fill(fill, Math.floor(size * 0.28), Math.floor(size * 0.28) + 200)
        return b
      }
      const first = bmp(0x11)
      const second = bmp(0x22)
      expect(first.length).toBe(second.length)

      const { entry, file } = await stripRow(
        [
          toolResultEntry('u-1', 'tool-1', [
            imageBlock(first, 'image/bmp'),
            imageBlock(second, 'image/bmp'),
          ]),
        ],
        0
      )
      const refFirst = decodeMediaRef(refsIn(entry)[0]!.id)!

      await fs.promises.writeFile(
        file,
        JSON.stringify(toolResultEntry('u-1', 'tool-1', [imageBlock(second, 'image/bmp')])) + '\n'
      )
      expect(await openMediaBlob(file, refFirst)).toBeUndefined()
    })

    it('leaves a payload with a malformed base64 length inline', async () => {
      // One extraneous '=' makes every decoded-length formula disagree with
      // what the decoder emits, and that number is served as Content-Length.
      const image = fakeImage(PNG_MAGIC, 30 * 1024, 0x44)
      const malformed = image.toString('base64').replace(/=+$/, '') + '='
      expect(malformed.length % 4).toBe(1)
      const { entry } = await stripRow(
        [
          toolResultEntry('u-1', 'tool-1', [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: malformed } },
          ]),
        ],
        0
      )
      expect(refsIn(entry)).toHaveLength(0)
    })

    it('tears down the source and its handle when the consumer gives up', async () => {
      const { entry, file } = await stripRow(
        [toolResultEntry('u-1', 'tool-1', [imageBlock(BIG_PNG)])],
        0
      )
      const handles: fs.promises.FileHandle[] = []
      const realOpen = fs.promises.open
      const spy = vi
        .spyOn(fs.promises, 'open')
        .mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
          const handle = await realOpen(...args)
          handles.push(handle)
          return handle
        })
      const blob = await openMediaBlob(file, decodeMediaRef(refsIn(entry)[0]!.id)!)
      spy.mockRestore()
      expect(blob).toBeDefined()

      // What a browser cancelling an image request does to the response body.
      blob!.stream.destroy()
      await new Promise((resolve) => setTimeout(resolve, 100))

      let open = true
      try {
        await handles[0]!.stat()
      } catch {
        open = false
      }
      expect(open).toBe(false)
    })

    it('surfaces storage failures instead of calling the media gone', async () => {
      // EIO says nothing about whether the image still exists; answering 410
      // would strand the client on a placeholder it never retries.
      const { entry, file } = await stripRow(
        [toolResultEntry('u-1', 'tool-1', [imageBlock(BIG_PNG)])],
        0
      )
      const ref = decodeMediaRef(refsIn(entry)[0]!.id)!
      const realOpen = fs.promises.open
      const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async () => {
        const error: NodeJS.ErrnoException = new Error('simulated I/O failure')
        error.code = 'EIO'
        throw error
      })
      await expect(openMediaBlob(file, ref)).rejects.toThrow(/simulated I\/O failure/)
      spy.mockRestore()
      expect(realOpen).toBeDefined()
    })

    it('serves normally when reads come back short of the requested length', async () => {
      // Positional reads may legally return fewer bytes than asked for before
      // EOF; that is not a truncated transcript.
      const { entry, file } = await stripRow(
        [toolResultEntry('u-1', 'tool-1', [imageBlock(BIG_PNG)])],
        0
      )
      const ref = decodeMediaRef(refsIn(entry)[0]!.id)!
      const realOpen = fs.promises.open
      const spy = vi
        .spyOn(fs.promises, 'open')
        .mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
          const handle = await realOpen(...args)
          const realRead = handle.read.bind(handle)
          // Only the small validation windows; the stream's large reads pass
          // through so the test stays fast.
          handle.read = ((buf: Buffer, off: number, len: number, pos: number) =>
            realRead(buf, off, len <= 128 ? 1 : len, pos)) as typeof handle.read
          return handle
        })
      const blob = await openMediaBlob(file, ref)
      spy.mockRestore()
      expect(blob).toBeDefined()
      expect((await collectStream(blob!.stream)).equals(BIG_PNG)).toBe(true)
    })
  })


  describe('intrinsic dimensions', () => {
    // A ref replaces bytes that used to arrive inline, so without these the
    // element has nothing to size itself from until the fetch lands.
    it('reads a PNG header', () => {
      const png = Buffer.alloc(24)
      PNG_MAGIC.copy(png)
      png.write('IHDR', 12, 'latin1')
      png.writeUInt32BE(919, 16)
      png.writeUInt32BE(1998, 20)
      expect(imageDimensions(png)).toEqual({ width: 919, height: 1998 })
    })

    it('walks JPEG segments past a leading EXIF block to the frame header', () => {
      // The size is not at a fixed offset: metadata segments come first.
      const exif = Buffer.alloc(2 + 2 + 400)
      exif[0] = 0xff
      exif[1] = 0xe1
      exif.writeUInt16BE(2 + 400, 2)
      const sof = Buffer.alloc(11)
      sof[0] = 0xff
      sof[1] = 0xc0
      sof.writeUInt16BE(8, 2)
      sof[4] = 8
      sof.writeUInt16BE(1998, 5)
      sof.writeUInt16BE(919, 7)
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, sof])
      expect(imageDimensions(jpeg)).toEqual({ width: 919, height: 1998 })
    })

    it('reads GIF and BMP headers, including a top-down bitmap', () => {
      const gif = Buffer.alloc(10)
      gif.write('GIF89a', 0, 'latin1')
      gif.writeUInt16LE(640, 6)
      gif.writeUInt16LE(360, 8)
      expect(imageDimensions(gif)).toEqual({ width: 640, height: 360 })

      const bmp = Buffer.alloc(26)
      bmp[0] = 0x42
      bmp[1] = 0x4d
      bmp.writeInt32LE(300, 18)
      bmp.writeInt32LE(-200, 22) // negative height = top-down
      expect(imageDimensions(bmp)).toEqual({ width: 300, height: 200 })
    })

    it('returns undefined rather than guessing when the header is unknown', () => {
      expect(imageDimensions(Buffer.from('not an image at all'))).toBeUndefined()
      expect(imageDimensions(Buffer.alloc(2))).toBeUndefined()
      // JPEG that reaches scan data without a frame header.
      expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0, 0, 0]))).toBeUndefined()
    })

    it('puts the dimensions on the minted ref', async () => {
      const png = Buffer.alloc(40 * 1024, 0xab)
      PNG_MAGIC.copy(png)
      png.write('IHDR', 12, 'latin1')
      png.writeUInt32BE(919, 16)
      png.writeUInt32BE(1998, 20)
      const { entry } = await stripRow([toolResultEntry('u-1', 'tool-1', [imageBlock(png)])], 0)
      const refs = refsIn(entry)
      expect(refs).toHaveLength(1)
      expect(refs[0]!.width).toBe(919)
      expect(refs[0]!.height).toBe(1998)
    })

    it('still mints a ref when the size cannot be read', async () => {
      // Sizing is a nicety; refusing to serve the image over it would not be.
      const { entry } = await stripRow(
        [toolResultEntry('u-1', 'tool-1', [imageBlock(fakeImage(JPEG_MAGIC, 30 * 1024, 0x5c))])],
        0
      )
      const refs = refsIn(entry)
      expect(refs).toHaveLength(1)
      expect(refs[0]!.width).toBeUndefined()
    })
  })

  describe('read paths', () => {
    async function createSession(agentSlug: string, sessionId: string, entries: object[]): Promise<string> {
      const dir = path.join(testDir, 'agents', agentSlug, 'workspace', '.claude', 'projects', '-workspace')
      await fs.promises.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${sessionId}.jsonl`)
      await fs.promises.writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
      return file
    }

    const transcript = [
      { type: 'user', uuid: 'u-0', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'take a shot' } },
      assistantWithToolUse('a-0', 'tool-0'),
      toolResultEntry('u-1', 'tool-0', [imageBlock(BIG_PNG)], {
        toolUseResult: { type: 'image', file: { base64: BIG_PNG.toString('base64') } },
      }),
      { type: 'assistant', uuid: 'a-1', timestamp: '2026-01-01T00:00:02.000Z', message: { id: 'msg-a1', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ]

    it('serves inline base64 by default and refs on request', async () => {
      const file = await createSession('agent-1', 'session-1', transcript)

      const inline = await getSessionMessagesPage('agent-1', 'session-1', { limit: 50 })
      const ref = await getSessionMessagesPage('agent-1', 'session-1', { limit: 50, media: 'ref' })

      // Same items either way — only the image blocks differ.
      expect(ref.messages.map((m) => m.id)).toEqual(inline.messages.map((m) => m.id))
      expect(ref.nextCursor).toBe(inline.nextCursor)
      expect(JSON.stringify(inline)).toContain(BIG_PNG.toString('base64'))
      expect(JSON.stringify(ref)).not.toContain(BIG_PNG.toString('base64'))

      const result = (ref.messages.find((m) => m.type === 'assistant') as { toolCalls: Array<{ result: unknown }> })
        .toolCalls[0]!.result as Array<{ type: string; id: string }>
      const block = result.find((b) => b.type === 'media_ref')!
      expect(block).toBeDefined()
      const blob = await openMediaBlob(file, decodeMediaRef(block.id)!)
      expect((await collectStream(blob!.stream)).equals(BIG_PNG)).toBe(true)
    })

    it('serves refs on the delta path too, where live screenshots arrive', async () => {
      const file = await createSession('agent-1', 'session-2', transcript)

      const delta = await getSessionMessagesDelta('agent-1', 'session-2', {
        after: 'u-0',
        media: 'ref',
      })
      const serialized = JSON.stringify(delta)
      expect(serialized).not.toContain(BIG_PNG.toString('base64'))
      expect(serialized).toContain('media_ref')

      const inlineDelta = await getSessionMessagesDelta('agent-1', 'session-2', { after: 'u-0' })
      expect(delta.messages.map((m) => m.id)).toEqual(inlineDelta.messages.map((m) => m.id))
      expect(JSON.stringify(inlineDelta)).toContain(BIG_PNG.toString('base64'))

      const result = (delta.messages.find((m) => m.type === 'assistant') as { toolCalls: Array<{ result: unknown }> })
        .toolCalls[0]!.result as Array<{ type: string; id: string }>
      const block = result.find((b) => b.type === 'media_ref')!
      const blob = await openMediaBlob(file, decodeMediaRef(block.id)!)
      expect((await collectStream(blob!.stream)).equals(BIG_PNG)).toBe(true)
    })

    it('addresses images correctly from a cursor page deep in a transcript', async () => {
      // Refs are minted from a window that starts mid-file: the offsets have to
      // be absolute, not window-relative.
      const filler = Array.from({ length: 40 }, (_, i) => ({
        type: 'user',
        uuid: `f-${i}`,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: `filler ${i}` },
      }))
      const file = await createSession('agent-1', 'session-3', [...transcript, ...filler])

      const page = await getSessionMessagesPage('agent-1', 'session-3', {
        limit: 10,
        cursor: 'f-5',
        media: 'ref',
      })
      const assistant = page.messages.find(
        (m) => m.type === 'assistant' && m.toolCalls.length > 0
      ) as { toolCalls: Array<{ result: unknown }> } | undefined
      expect(assistant).toBeDefined()
      const result = assistant!.toolCalls[0]!.result as Array<{ type: string; id: string }>
      const block = result.find((b) => b.type === 'media_ref')!
      expect(block).toBeDefined()
      const blob = await openMediaBlob(file, decodeMediaRef(block.id)!)
      expect((await collectStream(blob!.stream)).equals(BIG_PNG)).toBe(true)
    })
  })
})
