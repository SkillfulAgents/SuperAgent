import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  MEDIA_INLINE_MAX_BYTES,
  decodeMediaRef,
  encodeMediaRef,
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
    replaceInlineMediaWithRefs(entry, {
      agentSlug: 'agent-1',
      sessionId: 'session-1',
      line,
      lineOffset: offsets[index]!,
    })
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
      expect(refs[0]!.url).toBe(
        `/api/agents/agent-1/sessions/session-1/media/${refs[0]!.id}`
      )
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
      const ref = { v: 1 as const, u: 'u-1', o: 10, s: 20, l: 40 }
      expect(await openMediaBlob(path.join(testDir, 'gone.jsonl'), ref)).toBeUndefined()
    })

    it('round-trips a ref through its encoding', () => {
      const ref = { v: 1 as const, u: 'abc-123', o: 42, s: 4096, l: 8192 }
      expect(decodeMediaRef(encodeMediaRef(ref))).toEqual(ref)
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
