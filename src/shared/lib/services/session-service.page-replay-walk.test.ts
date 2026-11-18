/**
 * Randomized page walks over transcripts with replayed rows.
 *
 * On resume the CLI can re-append rows of earlier history verbatim. A page
 * window that holds a copy without its original shows the copy as a message;
 * a window that holds both shows the original. The hand-written fixtures in
 * session-service.test.ts pin each rule; this file walks many small
 * transcripts, with replays and system runs placed at random, and checks what
 * every walk owes a client:
 *  - it ends, and every cursor seeks further down the file than the last;
 *  - no page is empty;
 *  - every item of the whole transcript is on some page (a page may repeat
 *    an item: a copy first, its original later).
 *
 * Not covered: a system row replayed in the middle of a turn. A replayed
 * boundary that directly follows a new one hides it in a window that lacks
 * the replayed boundary's original (a run shows only its newest boundary).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { getSessionMessagesPage, getSessionMessagesWithCompact } from './session-service'
import { parsePageCursor } from './session-page-cursor'
import { createLocalSessionStore } from '@shared/lib/agent-actor/local-session-store'
import { prng } from '@shared/lib/agent-actor/testing/prng'
import { transformMessages } from '@shared/lib/utils/message-transform'

const AGENT = 'replay-walk-agent'
const SESSION = 'replay-walk-session'
const SEEDS = 60
const LIMITS = [1, 2, 3, 5, 8]
// The rows here are a few hundred bytes, so this budget stops a window after
// a handful of them, the way the real budgets stop one after a few turns.
const BUDGETS = [undefined, 1500]

let testDir: string
let originalDataDir: string | undefined

beforeAll(async () => {
  testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-replay-walk-'))
  originalDataDir = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = testDir
})

afterAll(async () => {
  if (originalDataDir) process.env.SUPERAGENT_DATA_DIR = originalDataDir
  else delete process.env.SUPERAGENT_DATA_DIR
  await fs.promises.rm(testDir, { recursive: true, force: true })
})

type Row = { type: string; uuid: string }

/** Turns of a question, sometimes a two-row response with a tool call and its
 * result, and an answer. With `systemRuns`, some turns end in a run of one to
 * four system rows (one boundary a run at most). */
function buildTranscript(rand: () => number, turns: number, systemRuns: boolean): Row[] {
  const rows: Row[] = []
  let second = 0
  const at = () => new Date(Date.UTC(2026, 0, 3, 0, 0, second++)).toISOString()
  const push = (row: object) => rows.push(row as Row)
  for (let t = 0; t < turns; t++) {
    push({ type: 'user', uuid: `u-${t}`, timestamp: at(), sessionId: SESSION, parentUuid: null, message: { role: 'user', content: `step ${t}` } })
    if (rand() < 0.7) {
      push({ type: 'assistant', uuid: `a-${t}-0`, timestamp: at(), sessionId: SESSION, parentUuid: null, message: { id: `msg-${t}`, role: 'assistant', content: [{ type: 'text', text: `working ${t}` }] } })
      push({ type: 'assistant', uuid: `a-${t}-1`, timestamp: at(), sessionId: SESSION, parentUuid: null, message: { id: `msg-${t}`, role: 'assistant', content: [{ type: 'tool_use', id: `t-${t}`, name: 'Read', input: {} }] } })
      push({ type: 'user', uuid: `r-${t}`, timestamp: at(), sessionId: SESSION, parentUuid: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${t}`, content: 'x'.repeat(50 + Math.floor(rand() * 600)) }] } })
    }
    push({ type: 'assistant', uuid: `f-${t}`, timestamp: at(), sessionId: SESSION, parentUuid: null, message: { id: `fin-${t}`, role: 'assistant', content: [{ type: 'text', text: `done ${t}` }] } })
    if (!systemRuns || rand() >= 0.4) continue
    let boundary = false
    for (let k = 0, n = 1 + Math.floor(rand() * 4); k < n; k++) {
      const pick = rand()
      const uuid = `sys-${t}-${k}`
      if (pick < 0.4) push({ type: 'system', uuid, subtype: 'informational', content: `note ${uuid}`, isMeta: false, timestamp: at() })
      else if (pick < 0.7 || boundary) push({ type: 'system', uuid, subtype: 'memory_recall', content: '', isMeta: false, timestamp: at(), memory_paths: ['M.md'] })
      else {
        boundary = true
        push({ type: 'system', uuid, subtype: 'compact_boundary', content: '', isMeta: false, timestamp: at(), compactMetadata: { trigger: 'manual', preTokens: 1 } })
      }
    }
  }
  return rows
}

/** One to three slices of earlier rows, re-appended verbatim after their own
 * position. `'messages anywhere'` replays message rows at any row;
 * `'rows after a turn'` replays system rows too, where a turn has ended. */
function withReplays(rand: () => number, base: Row[], mode: 'messages anywhere' | 'rows after a turn'): Row[] {
  const rows = base.slice()
  for (let i = 0, n = 1 + Math.floor(rand() * 3); i < n; i++) {
    const from = Math.floor(rand() * (base.length - 1))
    let slice = base.slice(from, from + 1 + Math.floor(rand() * 6))
    if (mode === 'messages anywhere') slice = slice.filter((row) => row.type !== 'system')
    if (slice.length === 0) continue
    const last = rows.lastIndexOf(slice.at(-1)!)
    let insertAt = last + 1 + Math.floor(rand() * (rows.length - last))
    if (mode === 'rows after a turn') {
      while (insertAt < rows.length && !rows[insertAt - 1]!.uuid.startsWith('f-')) insertAt++
    }
    rows.splice(insertAt, 0, ...slice)
  }
  return rows
}

async function writeTranscript(rows: Row[]): Promise<void> {
  const dir = path.join(testDir, 'agents', AGENT, 'workspace', '.claude', 'projects', '-workspace')
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(path.join(dir, `${SESSION}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

/** What is wrong with one walk, in words; empty when nothing is. */
async function walkProblems(limit: number, byteBudget: number | undefined, wholeIds: string[]): Promise<string[]> {
  const store = createLocalSessionStore(AGENT)
  const budget = byteBudget !== undefined ? { byteBudget } : {}
  const problems: string[] = []
  let page = await getSessionMessagesPage(store, SESSION, { limit, ...budget })
  const shown = new Set(page.messages.map((m) => m.id))
  let anchor = Infinity
  for (let i = 0; i < 400 && page.nextCursor; i++) {
    const { offset } = parsePageCursor(page.nextCursor)
    if (offset === undefined) problems.push(`bare-id cursor ${page.nextCursor}`)
    else if (offset >= anchor) problems.push(`cursor ${page.nextCursor} does not descend from ${anchor}`)
    else anchor = offset
    page = await getSessionMessagesPage(store, SESSION, { limit, cursor: page.nextCursor, ...budget })
    if (page.messages.length === 0) problems.push('empty page')
    for (const m of page.messages) shown.add(m.id)
  }
  if (page.nextCursor !== null) problems.push('did not end in 400 pages')
  const missing = wholeIds.filter((id) => !shown.has(id))
  if (missing.length > 0) problems.push(`never served: ${missing.join(' ')}`)
  return problems
}

describe('page walks over replayed transcripts', () => {
  it.each(['messages anywhere', 'rows after a turn'] as const)('serve the whole transcript and end: %s', async (mode) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failures: string[] = []
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = prng(seed)
      // Every third transcript has system runs.
      await writeTranscript(withReplays(rand, buildTranscript(rand, 6 + Math.floor(rand() * 14), seed % 3 === 0), mode))
      const entries = await getSessionMessagesWithCompact(createLocalSessionStore(AGENT), SESSION)
      const wholeIds = transformMessages(entries.filter((e) => !('isMeta' in e && e.isMeta))).map((m) => m.id)
      for (const byteBudget of BUDGETS) {
        for (const limit of LIMITS) {
          for (const problem of await walkProblems(limit, byteBudget, wholeIds)) {
            failures.push(`seed ${seed}, limit ${limit}, budget ${byteBudget ?? 'default'}: ${problem}`)
          }
        }
      }
    }
    warn.mockRestore()
    expect(failures).toEqual([])
  }, 60_000)
})
