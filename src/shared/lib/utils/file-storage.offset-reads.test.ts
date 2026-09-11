import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  iterateJsonlLinesBackward,
  readLineAt,
  findLineStartAtOrAfter,
} from './file-storage'

let dir: string
beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'offset-reads-'))
})
afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true })
})

async function write(name: string, content: string): Promise<string> {
  const p = path.join(dir, name)
  await fs.promises.writeFile(p, content)
  return p
}

async function collect(p: string, end?: number) {
  const out: { line: string; offset: number }[] = []
  for await (const { line, offset } of iterateJsonlLinesBackward(p, undefined, { end })) {
    out.push({ line: line.toString(), offset })
  }
  return out
}

describe('iterateJsonlLinesBackward with an end offset', () => {
  it('starts at the given line boundary and walks down to the file start', async () => {
    const p = await write('a.jsonl', 'aaa\nbbbb\ncc\nd\n')
    // Boundaries: aaa@0, bbbb@4, cc@9, d@12. End just after "bbbb\n" (=9).
    expect(await collect(p, 9)).toEqual([
      { line: 'bbbb', offset: 4 },
      { line: 'aaa', offset: 0 },
    ])
  })

  it('an end beyond EOF is clamped to EOF; end 0 yields nothing', async () => {
    const p = await write('b.jsonl', 'x\ny\n')
    expect(await collect(p, 10_000)).toEqual(await collect(p))
    expect(await collect(p, 0)).toEqual([])
  })

  it('an end at EOF of a file without a trailing newline yields the last row whole', async () => {
    const p = await write('c.jsonl', 'x\nlast')
    expect(await collect(p, 6)).toEqual([
      { line: 'last', offset: 2 },
      { line: 'x', offset: 0 },
    ])
  })

  it('walks a row that spans several read chunks when the end is set', async () => {
    const big = 'q'.repeat(200 * 1024)
    const p = await write('d.jsonl', `head\n${big}\ntail\n`)
    const rows = await collect(p, 5 + big.length + 1)
    expect(rows.map((r) => r.offset)).toEqual([5, 0])
    expect(rows[0]!.line.length).toBe(big.length)
  })
})

describe('readLineAt', () => {
  it('returns the row starting at a line boundary, without the newline', async () => {
    const p = await write('e.jsonl', 'aaa\nbbbb\ncc\n')
    expect((await readLineAt(p, 4))?.toString()).toBe('bbbb')
    expect((await readLineAt(p, 0))?.toString()).toBe('aaa')
    expect((await readLineAt(p, 9))?.toString()).toBe('cc')
  })

  it('returns the last row of a file without a trailing newline', async () => {
    const p = await write('f.jsonl', 'aaa\nend')
    expect((await readLineAt(p, 4))?.toString()).toBe('end')
  })

  it('returns undefined at or past EOF, and the tail of a row for a mid-row offset', async () => {
    const p = await write('g.jsonl', 'aaa\nbbbb\n')
    expect(await readLineAt(p, 9)).toBeUndefined()
    expect(await readLineAt(p, 500)).toBeUndefined()
    expect((await readLineAt(p, 6))?.toString()).toBe('bb')
  })

  it('reads only one row of a large file', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `{"i":${i},"pad":"${'p'.repeat(500)}"}`)
    const p = await write('h.jsonl', rows.join('\n') + '\n')
    const offset = rows.slice(0, 700).reduce((n, r) => n + r.length + 1, 0)
    expect((await readLineAt(p, offset))?.toString()).toBe(rows[700])
  })
})

describe('findLineStartAtOrAfter', () => {
  it('returns the target itself when it is a line boundary', async () => {
    const p = await write('i.jsonl', 'aaa\nbbbb\ncc\n')
    expect(await findLineStartAtOrAfter(p, 4)).toBe(4)
    expect(await findLineStartAtOrAfter(p, 9)).toBe(9)
    expect(await findLineStartAtOrAfter(p, 0)).toBe(0)
    expect(await findLineStartAtOrAfter(p, -3)).toBe(0)
  })

  it('rounds a mid-row target up to the next line start', async () => {
    const p = await write('j.jsonl', 'aaa\nbbbb\ncc\n')
    expect(await findLineStartAtOrAfter(p, 1)).toBe(4)
    expect(await findLineStartAtOrAfter(p, 6)).toBe(9)
  })

  it('answers EOF for a target inside the final row, and undefined past the last newline', async () => {
    const p = await write('k.jsonl', 'aaa\nbbbb\ncc\n')
    // Inside "cc\n": the newline at 11 → line start 12 == EOF.
    expect(await findLineStartAtOrAfter(p, 10)).toBe(12)
    expect(await findLineStartAtOrAfter(p, 12)).toBe(12)
    expect(await findLineStartAtOrAfter(p, 13)).toBeUndefined()
    const q = await write('l.jsonl', 'aaa\nnoeol')
    expect(await findLineStartAtOrAfter(q, 5)).toBeUndefined()
  })

  it('crosses read chunks to find a newline behind a huge row', async () => {
    const big = 'q'.repeat(300 * 1024)
    const p = await write('m.jsonl', `head\n${big}\ntail\n`)
    expect(await findLineStartAtOrAfter(p, 6)).toBe(5 + big.length + 1)
  })

  it('answers undefined for a missing file', async () => {
    expect(await findLineStartAtOrAfter(path.join(dir, 'nope.jsonl'), 5)).toBeUndefined()
  })
})
