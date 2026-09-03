/**
 * Offset-carrying page cursors (`uuid:offset`): the server seeks to the
 * cursor row instead of re-scanning from EOF, which makes every page O(page)
 * and lifts the id-only reachability cap. These tests pin that the seek path
 * serves the same pages as the legacy id-only scan, degrades to it when the
 * offset is stale, and reaches history the id-only walk cannot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { getSessionMessagesPage, getSessionMessagesWithCompact } from './session-service'
import { parsePageCursor, formatPageCursor } from './session-page-cursor'
import { readLineAt } from '@shared/lib/utils/file-storage'
import { transformMessages } from '@shared/lib/utils/message-transform'

const AGENT = 'offset-agent'
let testDir: string
let originalDataDir: string | undefined

beforeEach(async () => {
  testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cursor-offset-'))
  originalDataDir = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = testDir
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (originalDataDir) process.env.SUPERAGENT_DATA_DIR = originalDataDir
  else delete process.env.SUPERAGENT_DATA_DIR
  await fs.promises.rm(testDir, { recursive: true, force: true })
})

function jsonlPath(sessionId: string): string {
  return path.join(
    testDir, 'agents', AGENT, 'workspace', '.claude', 'projects', '-workspace', `${sessionId}.jsonl`
  )
}

async function writeTranscript(sessionId: string, entries: object[]): Promise<void> {
  const p = jsonlPath(sessionId)
  await fs.promises.mkdir(path.dirname(p), { recursive: true })
  await fs.promises.writeFile(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

const ts = (s: number) => new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString()

/** Plain user/assistant alternation. */
function simpleThread(turns: number): object[] {
  const rows: object[] = []
  for (let i = 0; i < turns; i++) {
    rows.push({ type: 'user', uuid: `u-${i}`, timestamp: ts(i * 2), sessionId: 's', parentUuid: null, message: { role: 'user', content: `q${i}` } })
    rows.push({ type: 'assistant', uuid: `a-${i}`, timestamp: ts(i * 2 + 1), sessionId: 's', parentUuid: `u-${i}`, message: { id: `msg-${i}`, role: 'assistant', content: [{ type: 'text', text: `a${i}` }] } })
  }
  return rows
}

/** Every shape the scanner special-cases: multi-entry assistant groups with
 * interleaved tool results, meta rows, queued commands, compact boundaries
 * with their summaries, contiguous system runs (recall / boundary /
 * informational, which the transform reorders), and the odd huge row. */
function mixedThread(turns: number): object[] {
  const rows: object[] = []
  let t = 0
  for (let i = 0; i < turns; i++) {
    rows.push({ type: 'user', uuid: `u-${i}`, timestamp: ts(t++), sessionId: 's', parentUuid: null, message: { role: 'user', content: `q${i}` } })
    if (i % 5 === 3) {
      rows.push({ type: 'user', uuid: `meta-${i}`, timestamp: ts(t++), sessionId: 's', parentUuid: null, isMeta: true, message: { role: 'user', content: 'meta' } })
    }
    rows.push({ type: 'assistant', uuid: `a-${i}-0`, timestamp: ts(t++), sessionId: 's', parentUuid: `u-${i}`, message: { id: `msg-${i}`, role: 'assistant', content: [{ type: 'thinking', thinking: `think ${i}` }, { type: 'text', text: `plan ${i}` }] } })
    rows.push({ type: 'assistant', uuid: `a-${i}-1`, timestamp: ts(t++), sessionId: 's', parentUuid: `a-${i}-0`, message: { id: `msg-${i}`, role: 'assistant', content: [{ type: 'tool_use', id: `t-${i}`, name: 'Bash', input: { command: `echo ${i}` } }] } })
    const pad = i % 13 === 6 ? 'y'.repeat(120 * 1024) : `out ${i}`
    rows.push({ type: 'user', uuid: `r-${i}`, timestamp: ts(t++), sessionId: 's', parentUuid: `a-${i}-1`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${i}`, content: pad }] } })
    rows.push({ type: 'assistant', uuid: `a-${i}-2`, timestamp: ts(t++), sessionId: 's', parentUuid: `r-${i}`, message: { id: `msg-${i}b`, role: 'assistant', content: [{ type: 'text', text: `done ${i}` }] } })
    if (i % 7 === 2) {
      rows.push({ type: 'system', uuid: `info-${i}`, subtype: 'informational', content: `Operation stopped by hook: ${i}`, isMeta: false, timestamp: ts(t++) })
      rows.push({ type: 'system', uuid: `mr-${i}`, subtype: 'memory_recall', content: '', isMeta: false, timestamp: ts(t++), memory_paths: ['MEMORY.md'] })
    }
    if (i % 11 === 9) {
      rows.push({ type: 'system', uuid: `cb-${i}`, subtype: 'compact_boundary', content: '', isMeta: false, timestamp: ts(t++), compactMetadata: { trigger: 'auto', preTokens: 1 } })
      rows.push({ type: 'user', uuid: `cs-${i}`, timestamp: ts(t++), sessionId: 's', parentUuid: null, isCompactSummary: true, message: { role: 'user', content: `summary ${i}` } })
    }
  }
  return rows
}

interface Walk {
  ids: string[]
  pages: number
  cursors: string[]
}

/** Walk from the trailing page to the start. `legacy` strips offsets so every
 * request takes the id-only path. */
async function walk(
  sessionId: string,
  opts: { first: number; older: number; byteBudget?: number; legacy?: boolean; maxPages?: number }
): Promise<Walk> {
  const budget = opts.byteBudget !== undefined ? { byteBudget: opts.byteBudget } : {}
  let page = await getSessionMessagesPage(AGENT, sessionId, { limit: opts.first, ...budget })
  const ids = page.messages.map((m) => m.id)
  const cursors: string[] = []
  let pages = 1
  let cursor = page.nextCursor
  const maxPages = opts.maxPages ?? 5000
  while (cursor) {
    if (pages >= maxPages) throw new Error(`walk did not terminate within ${maxPages} pages`)
    cursors.push(cursor)
    page = await getSessionMessagesPage(AGENT, sessionId, {
      limit: opts.older,
      cursor: opts.legacy ? parsePageCursor(cursor).id : cursor,
      ...budget,
    })
    pages++
    ids.unshift(...page.messages.map((m) => m.id))
    cursor = page.nextCursor
  }
  return { ids, pages, cursors }
}

async function fullIds(sessionId: string): Promise<string[]> {
  const entries = await getSessionMessagesWithCompact(AGENT, sessionId)
  return transformMessages(entries.filter((m) => !('isMeta' in m && m.isMeta))).map((m) => m.id)
}

describe('offset cursors — shape', () => {
  it('the trailing page hands out uuid:offset pointing at its oldest row', async () => {
    await writeTranscript('shape', simpleThread(20))
    const page = await getSessionMessagesPage(AGENT, 'shape', { limit: 6 })
    const cursor = parsePageCursor(page.nextCursor!)
    expect(cursor.id).toBe(page.messages[0]!.id)
    expect(cursor.offset).toBeTypeOf('number')
    const row = JSON.parse((await readLineAt(jsonlPath('shape'), cursor.offset!))!.toString())
    expect(row.uuid).toBe(cursor.id)
  })

  it('every cursor in a walk sits strictly deeper in the file than the last', async () => {
    await writeTranscript('descend', mixedThread(60))
    const { cursors } = await walk('descend', { first: 5, older: 4, byteBudget: 16 * 1024 })
    let prev = Number.POSITIVE_INFINITY
    for (const c of cursors) {
      const { offset } = parsePageCursor(c)
      // An id-only cursor is allowed (the progress guard), but an offset must descend.
      if (offset !== undefined) {
        expect(offset).toBeLessThan(prev)
        prev = offset
      }
    }
    expect(cursors.length).toBeGreaterThan(5)
  })

  it('an id-only request is answered with an offset cursor (clients upgrade transparently)', async () => {
    await writeTranscript('upgrade', simpleThread(30))
    const page = await getSessionMessagesPage(AGENT, 'upgrade', { limit: 4, cursor: 'u-20' })
    expect(page.messages.map((m) => m.id)).toEqual(['u-18', 'a-18', 'u-19', 'a-19'])
    expect(parsePageCursor(page.nextCursor!)).toEqual({ id: 'u-18', offset: expect.any(Number) })
  })
})

describe('offset cursors — equivalence with the id-only scan', () => {
  const combos: { first: number; older: number; byteBudget?: number }[] = [
    { first: 7, older: 5 },
    { first: 3, older: 3, byteBudget: 8 * 1024 },
    { first: 25, older: 10, byteBudget: 64 * 1024 },
    { first: 1, older: 1 },
  ]

  for (const combo of combos) {
    it(`serves the identical page sequence for limit ${combo.older}, budget ${combo.byteBudget ?? 'default'}`, async () => {
      await writeTranscript('equiv', mixedThread(80))
      const full = await fullIds('equiv')
      const seek = await walk('equiv', combo)
      const legacy = await walk('equiv', { ...combo, legacy: true })
      expect(seek.ids).toEqual(legacy.ids)
      expect(seek.ids).toEqual(full)
      expect(seek.pages).toBe(legacy.pages)
    })
  }

  it('matches on plain threads too', async () => {
    await writeTranscript('plain', simpleThread(500))
    const seek = await walk('plain', { first: 30, older: 20 })
    const legacy = await walk('plain', { first: 30, older: 20, legacy: true })
    expect(seek.ids).toEqual(legacy.ids)
    expect(seek.ids).toEqual(await fullIds('plain'))
  })
})

describe('offset cursors — reach', () => {
  it('walks past the id-only line cap to the start of a 60k-line transcript', async () => {
    const turns = 30_000
    await writeTranscript('deep', simpleThread(turns))
    const { ids, pages } = await walk('deep', { first: 300, older: 200 })
    expect(ids.length).toBe(turns * 2)
    expect(new Set(ids).size).toBe(turns * 2)
    expect(ids[0]).toBe('u-0')
    expect(pages).toBe(1 + Math.ceil((turns * 2 - 300) / 200))
  }, 120_000)

  it('an id-only cursor deeper than the line cap still ends pagination (legacy contract)', async () => {
    await writeTranscript('deep-legacy', simpleThread(30_000))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // u-100 is ~59,800 lines below EOF: unreachable without an offset.
    const page = await getSessionMessagesPage(AGENT, 'deep-legacy', { limit: 10, cursor: 'u-100' })
    expect(page).toEqual({ messages: [], nextCursor: null })
    expect(warn.mock.calls.some(([m]) => String(m).includes('not found within'))).toBe(true)
    // The same row is one seek away with its offset.
    const rows = simpleThread(30_000)
    const offset = rows.slice(0, 200).reduce((n, r) => n + JSON.stringify(r).length + 1, 0)
    const seeked = await getSessionMessagesPage(AGENT, 'deep-legacy', {
      limit: 10,
      cursor: formatPageCursor('u-100', offset),
    })
    expect(seeked.messages.map((m) => m.id)).toEqual([
      'u-95', 'a-95', 'u-96', 'a-96', 'u-97', 'a-97', 'u-98', 'a-98', 'u-99', 'a-99',
    ])
  }, 120_000)
})

describe('offset cursors — stale offsets degrade to the id scan', () => {
  async function expectFallback(sessionId: string, cursor: string) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const seeked = await getSessionMessagesPage(AGENT, sessionId, { limit: 4, cursor })
    const legacy = await getSessionMessagesPage(AGENT, sessionId, {
      limit: 4,
      cursor: parsePageCursor(cursor).id,
    })
    expect(seeked.messages.map((m) => m.id)).toEqual(legacy.messages.map((m) => m.id))
    expect(seeked.nextCursor).toBe(legacy.nextCursor)
    expect(warn.mock.calls.some(([m]) => String(m).includes('is stale'))).toBe(true)
    warn.mockRestore()
    return seeked
  }

  it('the row moved because an earlier row was deleted (rewrite)', async () => {
    const rows = simpleThread(40)
    await writeTranscript('moved', rows)
    const page = await getSessionMessagesPage(AGENT, 'moved', { limit: 6 })
    const cursor = page.nextCursor!
    // Delete a row well above the cursor: everything below shifts up.
    const kept = rows.filter((r) => (r as { uuid: string }).uuid !== 'u-3')
    await writeTranscript('moved', kept)
    const seeked = await expectFallback('moved', cursor)
    expect(seeked.messages.length).toBe(4)
    // And the fallback re-issues a fresh, valid offset.
    const next = parsePageCursor(seeked.nextCursor!)
    const row = JSON.parse((await readLineAt(jsonlPath('moved'), next.offset!))!.toString())
    expect(row.uuid).toBe(next.id)
  })

  it('the offset lands mid-row', async () => {
    await writeTranscript('midrow', simpleThread(40))
    const page = await getSessionMessagesPage(AGENT, 'midrow', { limit: 6 })
    const { id, offset } = parsePageCursor(page.nextCursor!)
    await expectFallback('midrow', formatPageCursor(id, offset! + 3))
  })

  it('the offset points at a different row', async () => {
    await writeTranscript('other-row', simpleThread(40))
    const page = await getSessionMessagesPage(AGENT, 'other-row', { limit: 6 })
    const { id } = parsePageCursor(page.nextCursor!)
    // Offset of the very first row (u-0), which is not the cursor row.
    await expectFallback('other-row', formatPageCursor(id, 0))
  })

  it('the offset is past EOF', async () => {
    await writeTranscript('past-eof', simpleThread(40))
    const page = await getSessionMessagesPage(AGENT, 'past-eof', { limit: 6 })
    const { id } = parsePageCursor(page.nextCursor!)
    await expectFallback('past-eof', formatPageCursor(id, 50_000_000))
  })

  it('the row is gone entirely: pagination ends, never serving a newer page', async () => {
    const rows = simpleThread(40)
    await writeTranscript('gone', rows)
    const page = await getSessionMessagesPage(AGENT, 'gone', { limit: 6 })
    const cursor = page.nextCursor!
    const { id } = parsePageCursor(cursor)
    await writeTranscript('gone', rows.filter((r) => (r as { uuid: string }).uuid !== id))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await getSessionMessagesPage(AGENT, 'gone', { limit: 4, cursor })).toEqual({
      messages: [],
      nextCursor: null,
    })
  })

  it('a missing transcript answers the empty terminal page for an offset cursor', async () => {
    expect(
      await getSessionMessagesPage(AGENT, 'nope', { limit: 4, cursor: formatPageCursor('u-1', 10) })
    ).toEqual({ messages: [], nextCursor: null })
  })
})

describe('offset cursors — grace window', () => {
  it('attaches a tool result that sits above the cursor row, like the id-only scan', async () => {
    // Cursor on the tool_use's assistant group; its result is the next row up.
    await writeTranscript('grace', mixedThread(12))
    const full = await getSessionMessagesPage(AGENT, 'grace', { limit: 200 })
    const target = full.messages.find((m) => m.id === 'a-8-2')!
    const idx = full.messages.indexOf(target)
    const cursorId = full.messages[idx + 1]!.id
    const offsets = new Map<string, number>()
    let off = 0
    for (const r of mixedThread(12)) {
      offsets.set((r as { uuid: string }).uuid, off)
      off += JSON.stringify(r).length + 1
    }
    const seeked = await getSessionMessagesPage(AGENT, 'grace', {
      limit: 3,
      cursor: formatPageCursor(cursorId, offsets.get(cursorId)!),
    })
    const legacy = await getSessionMessagesPage(AGENT, 'grace', { limit: 3, cursor: cursorId })
    expect(seeked.messages).toEqual(legacy.messages)
    const group = seeked.messages.find((m) => m.type === 'assistant' && 'toolCalls' in m && m.toolCalls.some((t) => t.id === 't-8'))
    expect(group).toBeDefined()
    expect((group as { toolCalls: { id: string; result?: unknown }[] }).toolCalls.find((t) => t.id === 't-8')!.result).toBeDefined()
  })
})
