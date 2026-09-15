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
import { iterateLinesBackward, readTailLines, streamLines } from './jsonl-files'

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

