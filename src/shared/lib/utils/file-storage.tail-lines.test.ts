/**
 * Structural coverage for readJsonlTailLines.
 *
 * Two contracts, only one of which the type system can see:
 *
 *  - `lines` is the last N rows of the file. The oracle here is a full read
 *    split on newlines, run against the same fixture.
 *  - `offsets[i]` is the byte position of `lines[i]` IN THE FILE. Nothing about
 *    the return type ties the two arrays together, and they are trimmed in
 *    lockstep by a shift, a pop and two slices. Media references address the
 *    transcript by these offsets, so a pairing that slips by one row resolves
 *    to a neighbouring row's bytes — every image in the session breaks with no
 *    type error and no failure anywhere else in the suite. Every case below
 *    checks the pairing, and fixtures carry a per-row index so a uniform shift
 *    cannot satisfy the comparison by accident.
 *
 * Its own file rather than more of file-storage.test.ts: the shrink-race case
 * needs a patched FileHandle.read, and that mock has no business being in scope
 * for the other ~60 file-storage tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { readJsonlTailLines } from './file-storage'

const TAIL_READ_CHUNK = 64 * 1024

let testDir: string

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-lines-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(testDir, { recursive: true, force: true })
})

function writeFixture(name: string, content: string): string {
  const filePath = path.join(testDir, name)
  fs.writeFileSync(filePath, content)
  return filePath
}

/** Rows are distinct and self-identifying, so a mispaired offset cannot match. */
function row(index: number, padBytes = 0): string {
  return JSON.stringify({ i: index, pad: 'x'.repeat(padBytes) })
}

/** Every returned offset addresses its own line, at a real line start. */
function expectOffsetsAddressTheirLines(
  filePath: string,
  result: { lines: Buffer[]; offsets: number[] }
): void {
  const file = fs.readFileSync(filePath)
  expect(result.offsets).toHaveLength(result.lines.length)

  let previous = -1
  for (const [i, line] of result.lines.entries()) {
    const offset = result.offsets[i]!
    expect(offset).toBeGreaterThan(previous)
    previous = offset
    // Addresses this row's bytes...
    expect(file.subarray(offset, offset + line.length).toString('utf-8')).toBe(
      line.toString('utf-8')
    )
    // ...and lands on a line start, not mid-row.
    expect(offset === 0 || file[offset - 1] === 0x0a).toBe(true)
  }
}

/**
 * The full-read oracle: the returned rows are a suffix of the file's rows,
 * `reachedStart` says whether that suffix is the whole file, and the count
 * never exceeds what was asked for.
 *
 * A tail that stops mid-file discards its leading partial row, so the result
 * can be SHORTER than maxLines. That is expected, and the file-fits-in-one-
 * chunk case below pins the exact count where it is knowable.
 */
async function expectMatchesOracle(filePath: string, maxLines: number) {
  const content = fs.readFileSync(filePath, 'utf-8')
  const all = content.split('\n')
  if (all[all.length - 1] === '') all.pop()

  const result = await readJsonlTailLines(filePath, maxLines)
  const got = result.lines.map((l) => l.toString('utf-8'))

  expect(got.length).toBeLessThanOrEqual(Math.max(0, maxLines))
  expect(got).toEqual(all.slice(all.length - got.length))
  expect(result.reachedStart).toBe(got.length === all.length)
  expectOffsetsAddressTheirLines(filePath, result)
  return result
}

describe('readJsonlTailLines — line boundaries', () => {
  it('keeps the final row when the file has no trailing newline', async () => {
    const filePath = writeFixture('no-trailing.jsonl', `${row(1)}\n${row(2)}\n${row(3)}`)

    const result = await expectMatchesOracle(filePath, 10)
    expect(result.lines.map((l) => l.toString('utf-8'))).toEqual([row(1), row(2), row(3)])
    expect(result.reachedStart).toBe(true)
  })

  it('does not emit an empty row for the trailing newline', async () => {
    const filePath = writeFixture('trailing.jsonl', `${row(1)}\n${row(2)}\n`)

    const result = await expectMatchesOracle(filePath, 10)
    expect(result.lines).toHaveLength(2)
  })

  it('retains the carriage return of a CRLF transcript, which still parses as JSON', async () => {
    const filePath = writeFixture('crlf.jsonl', `${row(1)}\r\n${row(2)}\r\n`)

    const result = await expectMatchesOracle(filePath, 10)
    // Rows split on \n only: the \r stays on the row, where JSON.parse treats
    // it as trailing whitespace. Offsets must still land on the row start.
    expect(result.lines.map((l) => l.toString('utf-8'))).toEqual([`${row(1)}\r`, `${row(2)}\r`])
    expect(result.lines.map((l) => JSON.parse(l.toString('utf-8')))).toEqual([
      { i: 1, pad: '' },
      { i: 2, pad: '' },
    ])
  })

  it('reads a blank row inside the file as a real, empty row', async () => {
    const filePath = writeFixture('blank-inside.jsonl', `${row(1)}\n\n${row(2)}\n`)

    const result = await expectMatchesOracle(filePath, 10)
    expect(result.lines.map((l) => l.toString('utf-8'))).toEqual([row(1), '', row(2)])
  })
})

describe('readJsonlTailLines — maxLines boundary', () => {
  const content = `${row(1)}\n${row(2)}\n${row(3)}\n`

  it('returns every row and reaches the start when maxLines equals the row count', async () => {
    const filePath = writeFixture('exact.jsonl', content)

    const result = await expectMatchesOracle(filePath, 3)
    expect(result.lines).toHaveLength(3)
    expect(result.reachedStart).toBe(true)
  })

  it('drops the oldest row and reports more history when maxLines is one short', async () => {
    const filePath = writeFixture('one-short.jsonl', content)

    const result = await expectMatchesOracle(filePath, 2)
    expect(result.lines.map((l) => l.toString('utf-8'))).toEqual([row(2), row(3)])
    expect(result.reachedStart).toBe(false)
  })

  it('reaches the start when maxLines overshoots the row count', async () => {
    const filePath = writeFixture('overshoot.jsonl', content)

    const result = await expectMatchesOracle(filePath, 4)
    expect(result.lines).toHaveLength(3)
    expect(result.reachedStart).toBe(true)
  })

  it('returns nothing for maxLines of zero or below, without opening the file', async () => {
    const open = vi.spyOn(fs.promises, 'open')
    const filePath = writeFixture('unopened.jsonl', content)

    for (const maxLines of [0, -1, -100]) {
      const result = await readJsonlTailLines(filePath, maxLines)
      expect(result).toEqual({ lines: [], offsets: [], reachedStart: true })
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('returns nothing and reaches the start for an empty file', async () => {
    const filePath = writeFixture('empty.jsonl', '')

    const result = await readJsonlTailLines(filePath, 10)
    expect(result).toEqual({ lines: [], offsets: [], reachedStart: true })
  })
})

describe('readJsonlTailLines — rows larger than the read chunk', () => {
  it('assembles a single row spanning several chunks and offsets it at the file start', async () => {
    const big = row(1, TAIL_READ_CHUNK * 2)
    const filePath = writeFixture('huge-row.jsonl', `${big}\n${row(2)}\n`)

    const result = await expectMatchesOracle(filePath, 2)
    expect(result.lines[0]!.length).toBeGreaterThan(TAIL_READ_CHUNK)
    expect(result.offsets).toEqual([0, big.length + 1])
    expect(result.reachedStart).toBe(true)
  })

  it('offsets the trailing row correctly when the huge row is never assembled', async () => {
    const big = row(1, TAIL_READ_CHUNK * 2)
    const filePath = writeFixture('huge-skipped.jsonl', `${big}\n${row(2)}\n`)

    // Only the trailing row is wanted: the backward walk stops one chunk in and
    // the multi-chunk row is never concatenated — but the row it did return is
    // still addressed against the whole file.
    const result = await expectMatchesOracle(filePath, 1)
    expect(result.lines.map((l) => l.toString('utf-8'))).toEqual([row(2)])
    expect(result.offsets).toEqual([big.length + 1])
    expect(result.reachedStart).toBe(false)
  })

  it('addresses a tail read across many chunks', async () => {
    // ~256KB: four chunk reads before the walk has enough rows.
    const rows = Array.from({ length: 400 }, (_, i) => row(i, 600))
    const filePath = writeFixture('multi-chunk.jsonl', `${rows.join('\n')}\n`)

    const result = await expectMatchesOracle(filePath, 5)
    expect(result.lines.map((l) => JSON.parse(l.toString('utf-8')).i)).toEqual([
      395, 396, 397, 398, 399,
    ])
  })
})

describe('readJsonlTailLines — differential against a full read', () => {
  // Deterministic PRNG: a failing case is reproducible from the seed alone.
  function makeRandom(seed: number): () => number {
    let state = seed
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x100000000
    }
  }

  it('matches the full-read oracle across randomized fixtures', async () => {
    const random = makeRandom(20260820)

    for (let round = 0; round < 60; round++) {
      const rowCount = 1 + Math.floor(random() * 40)
      const rows = Array.from({ length: rowCount }, (_, i) =>
        // Row sizes straddle the chunk boundary so some rounds split rows
        // across reads and some do not.
        row(i, Math.floor(random() * 3000))
      )
      const trailingNewline = random() < 0.8
      const content = rows.join('\n') + (trailingNewline ? '\n' : '')
      const filePath = writeFixture(`fuzz-${round}.jsonl`, content)

      const maxLines = 1 + Math.floor(random() * (rowCount + 3))
      await expectMatchesOracle(filePath, maxLines)
    }
  })

  it('returns exactly maxLines rows whenever the file fits in one chunk read', async () => {
    const random = makeRandom(981)

    for (let round = 0; round < 25; round++) {
      const rowCount = 2 + Math.floor(random() * 20)
      const rows = Array.from({ length: rowCount }, (_, i) => row(i, Math.floor(random() * 200)))
      const filePath = writeFixture(`small-${round}.jsonl`, `${rows.join('\n')}\n`)
      expect(fs.statSync(filePath).size).toBeLessThan(TAIL_READ_CHUNK)

      const maxLines = 1 + Math.floor(random() * rowCount)
      const result = await expectMatchesOracle(filePath, maxLines)
      // A single-chunk read always reaches the start, so nothing is discarded
      // and the count is knowable exactly.
      expect(result.lines).toHaveLength(Math.min(maxLines, rowCount))
    }
  })
})

describe('readJsonlTailLines — file shrinking under the walk', () => {
  it('serves the cleanly read suffix instead of splicing across a rewrite', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(i, 800))
    const filePath = writeFixture('shrinking.jsonl', `${rows.join('\n')}\n`)

    // A transcript rewrite between chunk reads: the second read comes up
    // empty, as it would against a file that just got shorter. Splicing that
    // short chunk under the already-read tail would garble the row boundary
    // between them, so the walk has to stop and serve what it has.
    const realOpen = fs.promises.open.bind(fs.promises)
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof realOpen>))
      let reads = 0
      const realRead = handle.read.bind(handle)
      handle.read = (async (...readArgs: unknown[]) => {
        reads++
        if (reads > 1) return { bytesRead: 0, buffer: readArgs[0] as Buffer }
        return realRead(...(readArgs as Parameters<typeof realRead>))
      }) as typeof handle.read
      return handle
    })

    const result = await readJsonlTailLines(filePath, 500)

    expect(result.reachedStart).toBe(false)
    expect(result.lines.length).toBeGreaterThan(0)
    // Whatever came back is intact and correctly addressed — no half row
    // spliced onto the front, no offsets pointing into the gap.
    expectOffsetsAddressTheirLines(filePath, result)
    const indices = result.lines.map((l) => JSON.parse(l.toString('utf-8')).i)
    expect(indices[indices.length - 1]).toBe(199)
    expect(indices).toEqual(
      Array.from({ length: indices.length }, (_, k) => 200 - indices.length + k)
    )
  })
})
