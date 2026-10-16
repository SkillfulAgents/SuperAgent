/**
 * The line and JSONL readers over `FileOps`, exercised over a real directory
 * through `LocalFileOps`: the tests the path-based readers had, with the
 * file operations in between.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { LocalFileOps } from './local-file-ops'
import { iterateLinesBackward, readChunkFor, readTailLines, READ_CHUNK_MAX, READ_CHUNK_MIN, streamLines } from './jsonl-files'

let testDir: string
let files: LocalFileOps

/** The workspace path of a file the test wrote under the test directory. */
const rel = (filePath: string) => path.relative(testDir, filePath)

beforeEach(async () => {
  testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jsonl-files-test-'))
  files = new LocalFileOps(() => testDir)
})

afterEach(async () => {
  await fs.promises.rm(testDir, { recursive: true, force: true })
})

describe('readTailLines', () => {
  it('returns the last N lines without the earlier rows', async () => {
    const filePath = path.join(testDir, 'tail.jsonl')
    await fs.promises.writeFile(filePath, 'a\nb\nc\nd\ne\n')

    const { lines, reachedStart } = await readTailLines(files, rel(filePath), 2)
    expect(lines.map((l) => l.toString('utf-8'))).toEqual(['d', 'e'])
    expect(reachedStart).toBe(false)
  })

  it('marks reachedStart when the tail is the whole file', async () => {
    const filePath = path.join(testDir, 'short-tail.jsonl')
    await fs.promises.writeFile(filePath, 'a\nb\n')

    const { lines, reachedStart } = await readTailLines(files, rel(filePath), 10)
    expect(lines.map((l) => l.toString('utf-8'))).toEqual(['a', 'b'])
    expect(reachedStart).toBe(true)
  })

  it('returns empty for a missing file', async () => {
    const { lines, reachedStart } = await readTailLines(files, 'missing.jsonl', 5)
    expect(lines).toEqual([])
    expect(reachedStart).toBe(true)
  })

  // The abort signal exists so an HTTP caller whose client hung up stops
  // paying for the rest of a large transcript (reads are multi-second on
  // network volumes). Pin both halves: a pre-aborted signal never opens the
  // file, and an abort mid-walk stops before the next chunk read.
  it('rejects without opening the file when the signal is already aborted', async () => {
    const filePath = path.join(testDir, 'abort-pre.jsonl')
    await fs.promises.writeFile(filePath, 'a\nb\n')
    const openSpy = vi.spyOn(fs.promises, 'open')

    const controller = new AbortController()
    controller.abort()
    await expect(readTailLines(files, rel(filePath), 5, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(openSpy).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it('stops the backward walk when the signal aborts between chunk reads', async () => {
    // >4 chunks of 64KB so an unaborted read would take several iterations.
    const filePath = path.join(testDir, 'abort-mid.jsonl')
    const row = `${'x'.repeat(1023)}\n`
    await fs.promises.writeFile(filePath, row.repeat(300)) // ~300KB, ~5 chunks

    const controller = new AbortController()
    let reads = 0
    const realOpen = fs.promises.open.bind(fs.promises)
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof fs.promises.open>))
      const realRead = handle.read.bind(handle) as (...a: unknown[]) => unknown
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'read') {
            return (...readArgs: unknown[]) => {
              reads++
              controller.abort() // abort lands while the first read is in flight
              return realRead(...readArgs)
            }
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as Awaited<ReturnType<typeof fs.promises.open>>
    })

    // Ask for every line so only the abort can stop the walk early.
    await expect(readTailLines(files, rel(filePath), 100_000, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(reads).toBe(1)
    openSpy.mockRestore()
  })

  it('rejects without reading a chunk when the abort lands during open/stat', async () => {
    // The entry check runs before open(), but open and stat are themselves
    // awaited RPCs on network volumes — an abort landing inside them must be
    // observed before the first (also RPC-priced) chunk read starts.
    const filePath = path.join(testDir, 'abort-stat.jsonl')
    await fs.promises.writeFile(filePath, 'a\nb\nc\n')

    const controller = new AbortController()
    let reads = 0
    const realOpen = fs.promises.open.bind(fs.promises)
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof fs.promises.open>))
      const realStat = handle.stat.bind(handle) as (...a: unknown[]) => unknown
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'stat') {
            return (...statArgs: unknown[]) => {
              controller.abort() // abort lands while stat is in flight
              return realStat(...statArgs)
            }
          }
          if (prop === 'read') {
            return () => {
              reads++
              throw new Error('read must not start after the abort')
            }
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as Awaited<ReturnType<typeof fs.promises.open>>
    })

    await expect(readTailLines(files, rel(filePath), 10, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(reads).toBe(0)
    openSpy.mockRestore()
  })

  it('rejects when the abort lands during the final chunk read', async () => {
    // Single-chunk file: this read IS the final one, so there is no next loop
    // iteration to observe the abort — only a post-read check catches it
    // before the tail buffer is materialized and line-scanned.
    const filePath = path.join(testDir, 'abort-final.jsonl')
    await fs.promises.writeFile(filePath, 'a\nb\nc\n')

    const controller = new AbortController()
    const realOpen = fs.promises.open.bind(fs.promises)
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof fs.promises.open>))
      const realRead = handle.read.bind(handle) as (...a: unknown[]) => unknown
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'read') {
            return (...readArgs: unknown[]) => {
              controller.abort() // abort lands while the only read is in flight
              return realRead(...readArgs)
            }
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as Awaited<ReturnType<typeof fs.promises.open>>
    })

    await expect(readTailLines(files, rel(filePath), 10, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    openSpy.mockRestore()
  })

  it('ignores a never-aborted signal', async () => {
    const filePath = path.join(testDir, 'abort-none.jsonl')
    await fs.promises.writeFile(filePath, 'a\nb\nc\n')

    const controller = new AbortController()
    const { lines, reachedStart } = await readTailLines(files, rel(filePath), 10, controller.signal)
    expect(lines.map((l) => l.toString('utf-8'))).toEqual(['a', 'b', 'c'])
    expect(reachedStart).toBe(true)
  })
})

describe('iterateLinesBackward', () => {
  async function collect(filePath: string, signal?: AbortSignal) {
    const out: Array<{ text: string; offset: number }> = []
    for await (const { line, offset } of iterateLinesBackward(files, rel(filePath), signal)) {
      // Copy: yielded buffers may alias the iterator's internal chunk.
      out.push({ text: line.toString('utf-8'), offset })
    }
    return out
  }

  it('yields lines newest-first with their byte offsets', async () => {
    const filePath = path.join(testDir, 'backward.jsonl')
    const content = 'alpha\nbeta\ngamma\n'
    await fs.promises.writeFile(filePath, content)

    const lines = await collect(filePath)
    expect(lines.map((l) => l.text)).toEqual(['gamma', 'beta', 'alpha'])
    for (const { text, offset } of lines) {
      expect(content.slice(offset, offset + text.length)).toBe(text)
    }
  })

  it('handles a file without a trailing newline', async () => {
    const filePath = path.join(testDir, 'backward-no-eol.jsonl')
    await fs.promises.writeFile(filePath, 'a\nb\nlast')

    const lines = await collect(filePath)
    expect(lines.map((l) => l.text)).toEqual(['last', 'b', 'a'])
    expect(lines[0].offset).toBe(4)
  })

  it('reassembles a line larger than the read chunk', async () => {
    const filePath = path.join(testDir, 'backward-huge.jsonl')
    // One row far larger than the 64KB chunk, so its bytes span several
    // backward reads and must be stitched through the carry buffer.
    const huge = 'H'.repeat(200 * 1024)
    const content = `first\n${huge}\nlast\n`
    await fs.promises.writeFile(filePath, content)

    const lines = await collect(filePath)
    expect(lines.map((l) => l.text.length)).toEqual([4, huge.length, 5])
    expect(lines[1].text).toBe(huge)
    expect(lines[1].offset).toBe('first\n'.length)
  })

  it('yields nothing for a missing or empty file', async () => {
    expect(await collect(path.join(testDir, 'nope.jsonl'))).toEqual([])
    const emptyPath = path.join(testDir, 'empty.jsonl')
    await fs.promises.writeFile(emptyPath, '')
    expect(await collect(emptyPath)).toEqual([])
  })

  it('survives legal short reads without skipping bytes', async () => {
    // Network filesystems may return fewer bytes than requested mid-file.
    // Cap every positional read at 3 bytes: the walk must loop until each
    // chunk range is filled instead of leaving unread gaps that splice lines.
    const filePath = path.join(testDir, 'backward-short-reads.jsonl')
    await fs.promises.writeFile(filePath, 'alpha\nbeta\ngamma\n')

    const realOpen = fs.promises.open.bind(fs.promises)
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof fs.promises.open>))
      const realRead = handle.read.bind(handle) as (
        buf: Buffer, off: number, len: number, pos: number
      ) => Promise<{ bytesRead: number }>
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'read') {
            return (buf: Buffer, off: number, len: number, pos: number) =>
              realRead(buf, off, Math.min(3, len), pos)
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as Awaited<ReturnType<typeof fs.promises.open>>
    })

    try {
      const out: string[] = []
      for await (const { line } of iterateLinesBackward(files, rel(filePath))) {
        out.push(line.toString('utf-8'))
      }
      expect(out).toEqual(['gamma', 'beta', 'alpha'])

      const { lines, reachedStart } = await readTailLines(files, rel(filePath), 10)
      expect(lines.map((l) => l.toString('utf-8'))).toEqual(['alpha', 'beta', 'gamma'])
      expect(reachedStart).toBe(true)
    } finally {
      openSpy.mockRestore()
    }
  })

  it('an abort during short-read refills stops before the next physical read', async () => {
    // One logical chunk can take many physical reads on filesystems that
    // short-read; each is RPC-priced, so the refill loop must observe the
    // signal per read rather than only at chunk boundaries.
    const filePath = path.join(testDir, 'backward-refill-abort.jsonl')
    await fs.promises.writeFile(filePath, 'alpha\nbeta\ngamma\n')

    const controller = new AbortController()
    let reads = 0
    const realOpen = fs.promises.open.bind(fs.promises)
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof fs.promises.open>))
      const realRead = handle.read.bind(handle) as (
        buf: Buffer, off: number, len: number, pos: number
      ) => Promise<{ bytesRead: number }>
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'read') {
            return (buf: Buffer, off: number, len: number, pos: number) => {
              reads++
              controller.abort() // lands while the first short read is in flight
              return realRead(buf, off, Math.min(3, len), pos)
            }
          }
          const value = Reflect.get(target, prop, receiver)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as Awaited<ReturnType<typeof fs.promises.open>>
    })

    try {
      await expect(
        (async () => {
          for await (const item of iterateLinesBackward(files, rel(filePath), controller.signal)) {
            void item
          }
        })()
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(reads).toBe(1)
    } finally {
      openSpy.mockRestore()
    }
  })

  it('stops with AbortError before the next chunk read after an abort', async () => {
    // Multi-chunk file (>64KB) so the walk needs several reads: abort after
    // the first yielded line and the iterator must stop at the next chunk
    // boundary instead of paying for the rest of the file.
    const filePath = path.join(testDir, 'backward-abort.jsonl')
    const row = `${'x'.repeat(1023)}\n`
    await fs.promises.writeFile(filePath, row.repeat(300)) // ~300KB, ~5 chunks

    const controller = new AbortController()
    const iterated: string[] = []
    await expect(
      (async () => {
        for await (const { line } of iterateLinesBackward(files, rel(filePath), controller.signal)) {
          iterated.push(line.toString('utf-8'))
          controller.abort()
        }
      })()
    ).rejects.toMatchObject({ name: 'AbortError' })
    // Only the lines of the first chunk (64 rows of 1KB) can have been
    // yielded — the abort stops the walk before the second chunk read.
    expect(iterated.length).toBeGreaterThan(0)
    expect(iterated.length).toBeLessThanOrEqual(65)
  })
})

describe('streamLines with a byte range', () => {
  it('reads only lines inside [start, end)', async () => {
    const filePath = path.join(testDir, 'range.jsonl')
    const rows = ['zero', 'one', 'two', 'three']
    const content = rows.map((r) => `${r}\n`).join('')
    await fs.promises.writeFile(filePath, content)

    const start = 'zero\n'.length
    const end = 'zero\none\ntwo\n'.length
    const out: string[] = []
    for await (const line of streamLines(files, rel(filePath), { start, end })) {
      out.push(line.toString('utf-8'))
    }
    expect(out).toEqual(['one', 'two'])
  })

  it('a range ending mid-line yields the truncated head of that line', async () => {
    const filePath = path.join(testDir, 'range-cut.jsonl')
    await fs.promises.writeFile(filePath, 'aaa\nbbbbbb\n')

    const out: string[] = []
    for await (const line of streamLines(files, rel(filePath), { start: 0, end: 7 })) {
      out.push(line.toString('utf-8'))
    }
    // 'bbb' is the cut tail — JSONL consumers drop it as malformed.
    expect(out).toEqual(['aaa', 'bbb'])
  })

  it('an empty or inverted range yields nothing', async () => {
    const filePath = path.join(testDir, 'range-empty.jsonl')
    await fs.promises.writeFile(filePath, 'aaa\nbbb\n')
    const out: string[] = []
    for await (const line of streamLines(files, rel(filePath), { start: 4, end: 4 })) {
      out.push(line.toString('utf-8'))
    }
    expect(out).toEqual([])
  })

  it('aborts between chunks instead of reading the rest of the file', async () => {
    // Chunk-level abort granularity: a consumer-level per-line check is not
    // enough because a multi-MB row spans many chunks before it yields. Abort
    // after the first line: iteration must stop within one chunk's worth of
    // lines, not drain the remaining chunks.
    const filePath = path.join(testDir, 'stream-abort.jsonl')
    const row = `${'x'.repeat(1023)}\n`
    await fs.promises.writeFile(filePath, row.repeat(300)) // ~300KB, ~5 chunks

    const controller = new AbortController()
    const received: number[] = []
    await expect(
      (async () => {
        for await (const line of streamLines(files, rel(filePath), undefined, controller.signal)) {
          received.push(line.length)
          controller.abort()
        }
      })()
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(received.length).toBeGreaterThan(0)
    expect(received.length).toBeLessThanOrEqual(65)
  })
})


/**
 * The read sizes. Backward walks start at READ_CHUNK_MIN and double up to
 * READ_CHUNK_MAX, so a short tail costs one small read and a long walk costs
 * O(log) + bytes / 1 MiB reads; a ranged forward read takes the chunk size
 * its caller asks for. Each `read` here is a round trip on a network volume.
 */
describe('read sizes', () => {
  const MiB = 1024 * 1024

  /** Length of every FileHandle read issued while `fn` runs. */
  async function readLengths<T>(fn: () => Promise<T>): Promise<{ result: T; lengths: number[] }> {
    const lengths: number[] = []
    const realOpen = fs.promises.open.bind(fs.promises)
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof realOpen>))
      const realRead = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>
      handle.read = (async (...readArgs: unknown[]) => {
        const result = await realRead(...readArgs)
        // Every read the readers issue asks to fill a buffer at an offset:
        // (buffer, offset, length, position).
        lengths.push(readArgs[2] as number)
        return result
      }) as typeof handle.read
      return handle
    })
    try {
      return { result: await fn(), lengths }
    } finally {
      spy.mockRestore()
    }
  }

  /** Deterministic rows of mixed sizes, a few larger than the largest read. */
  function mixedRows(count: number, seed: number): string[] {
    let state = seed
    const random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x100000000
    }
    return Array.from({ length: count }, (_, i) => {
      const roll = random()
      const pad = roll < 0.02 ? 1.2 * MiB : roll < 0.2 ? 40_000 + Math.floor(random() * 90_000) : Math.floor(random() * 3000)
      return JSON.stringify({ i, pad: 'x'.repeat(pad) })
    })
  }

  async function writeRows(name: string, rows: string[], trailingNewline = true): Promise<{ filePath: string; content: string }> {
    const filePath = path.join(testDir, name)
    const content = rows.join('\n') + (trailingNewline ? '\n' : '')
    await fs.promises.writeFile(filePath, content)
    return { filePath, content }
  }

  it('clamps a requested chunk into [64 KiB, 1 MiB]', () => {
    expect(READ_CHUNK_MIN).toBe(64 * 1024)
    expect(READ_CHUNK_MAX).toBe(MiB)
    expect(readChunkFor(undefined)).toBe(READ_CHUNK_MIN)
    expect(readChunkFor(0)).toBe(READ_CHUNK_MIN)
    expect(readChunkFor(300_000)).toBe(300_000)
    expect(readChunkFor(10 * MiB)).toBe(READ_CHUNK_MAX)
    expect(readChunkFor(Number.POSITIVE_INFINITY)).toBe(READ_CHUNK_MIN)
  })

  it('walks backward in reads that double from 64 KiB to 1 MiB', async () => {
    const { filePath } = await writeRows('grow.jsonl', Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i, pad: 'y'.repeat(900) })))
    const size = fs.statSync(filePath).size
    expect(size).toBeGreaterThan(4 * MiB)

    const { lengths } = await readLengths(async () => {
      for await (const item of iterateLinesBackward(files, rel(filePath))) void item
    })

    const expected: number[] = []
    let remaining = size
    for (let chunk = READ_CHUNK_MIN; remaining > 0; chunk = Math.min(chunk * 2, READ_CHUNK_MAX)) {
      expected.push(Math.min(chunk, remaining))
      remaining -= Math.min(chunk, remaining)
    }
    expect(lengths).toEqual(expected)
    // A 4 MB walk: a handful of reads, where fixed 64 KiB reads took ~70.
    expect(lengths.length).toBeLessThan(12)
  })

  it('reads a short tail in one 64 KiB read, as before', async () => {
    const { filePath } = await writeRows('short-tail.jsonl', Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i, pad: 'p'.repeat(40) })))
    expect(fs.statSync(filePath).size).toBeGreaterThan(3 * READ_CHUNK_MIN)
    const { result, lengths } = await readLengths(() => readTailLines(files, rel(filePath), 20))
    expect(result.lines).toHaveLength(20)
    expect(lengths).toEqual([READ_CHUNK_MIN])
  })

  it('grows readTailLines the same way', async () => {
    const { filePath } = await writeRows('grow-tail.jsonl', Array.from({ length: 3000 }, (_, i) => JSON.stringify({ i, pad: 'z'.repeat(900) })))
    const { result, lengths } = await readLengths(() => readTailLines(files, rel(filePath), 2000))
    expect(result.lines).toHaveLength(2000)
    expect(lengths.slice(0, 5)).toEqual([READ_CHUNK_MIN, 2 * READ_CHUNK_MIN, 4 * READ_CHUNK_MIN, 8 * READ_CHUNK_MIN, READ_CHUNK_MAX])
  })

  it('matches the forward split across every growth boundary, rows larger than a read included', async () => {
    for (const [round, trailingNewline] of [[1, true], [2, false], [3, true]] as const) {
      const rows = mixedRows(260, round)
      const { filePath, content } = await writeRows(`oracle-${round}.jsonl`, rows, trailingNewline)
      const bytes = Buffer.from(content)
      expect(bytes.length).toBeGreaterThan(3 * MiB)

      // Backward walk: every row, newest first, each addressed at its own start.
      const walked: Array<{ text: string; offset: number }> = []
      for await (const { line, offset } of iterateLinesBackward(files, rel(filePath))) {
        walked.push({ text: line.toString('utf-8'), offset })
      }
      expect(walked.map((l) => l.text)).toEqual(rows.slice().reverse())
      for (const { text, offset } of walked) {
        expect(bytes.subarray(offset, offset + text.length).toString('utf-8')).toBe(text)
        expect(offset === 0 || bytes[offset - 1] === 0x0a).toBe(true)
      }

      // Tail reads of several depths: a suffix of the rows, offsets in lockstep.
      for (const maxLines of [1, 7, 60, 150, 1000]) {
        const tail = await readTailLines(files, rel(filePath), maxLines)
        const got = tail.lines.map((l) => l.toString('utf-8'))
        expect(got).toEqual(rows.slice(rows.length - got.length))
        expect(tail.reachedStart).toBe(got.length === rows.length)
        tail.offsets.forEach((offset, k) => {
          expect(bytes.subarray(offset, offset + got[k]!.length).toString('utf-8')).toBe(got[k])
        })
      }
    }
  })

  it('reads a range in the chunk size its caller asks for', async () => {
    const { filePath, content } = await writeRows('ranged.jsonl', Array.from({ length: 3000 }, (_, i) => JSON.stringify({ i, pad: 'r'.repeat(900) })))
    const start = content.indexOf('\n') + 1
    const end = content.length - 1000

    const collectRange = async (chunkBytes?: number) =>
      readLengths(async () => {
        const out: string[] = []
        for await (const line of streamLines(files, rel(filePath), { start, end }, undefined, chunkBytes)) {
          out.push(line.toString('utf-8'))
        }
        return out
      })

    const sized = await collectRange(MiB)
    const unsized = await collectRange()
    // The same lines either way…
    expect(sized.result).toEqual(unsized.result)
    // …in 1 MiB reads when asked (the last is what is left of the range), the
    // stream's 64 KiB default otherwise.
    expect(sized.lengths.slice(0, -1).every((n) => n === MiB)).toBe(true)
    expect(sized.lengths.length).toBe(Math.ceil((end - start) / MiB))
    expect(Math.max(...unsized.lengths)).toBe(64 * 1024)
  })
})
