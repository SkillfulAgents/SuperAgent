/**
 * Budgeted page walks over a realistic transcript.
 *
 * Clients may pick the page's byte budget (`max_bytes`: iOS 512 KiB for its
 * latest page and 1 MiB for older ones, the clamp floor 64 KiB), and the
 * readers walk the file in reads that grow from 64 KiB to 1 MiB.
 * The small fixtures in session-service.test.ts prove every classification
 * rule; this file proves the same contract at the scale where the new read
 * sizes and budgets actually bite: a multi-MB transcript of tool-heavy turns,
 * merge groups split across rows, results larger than a read, one row larger
 * than the largest read.
 *
 * The contract, for every budget mix a client sends:
 *  - each page's cursor is its first item, and the next (older) page ends
 *    exactly before it — no item skipped, none served twice;
 *  - every item equals the full transform's item (a merged assistant keeps all
 *    of its tool calls and their results: whole turn groups, never halves);
 *  - the walk terminates with a null cursor at the transcript start.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { getSessionMessagesPage, getSessionMessagesWithCompact } from './session-service'
import { createLocalSessionStore } from '@shared/lib/agent-actor/local-session-store'
import { prng } from '@shared/lib/agent-actor/testing/prng'
import { transformMessages, type TransformedItem } from '@shared/lib/utils/message-transform'

const KiB = 1024
const MiB = 1024 * KiB
const AGENT = 'budget-agent'
// Every older page re-walks the transcript from its end to the cursor (by
// design: the deepest duplicate uuid is the anchor), so a walk at the 64 KiB
// floor is ~100 such scans. Seconds on an idle machine; room for a busy one.
const WALK_TIMEOUT_MS = 120_000
const SESSION = 'budget-session'

let testDir: string
let originalDataDir: string | undefined
let transcriptBytes = 0
let full: TransformedItem[]
let replayFull: TransformedItem[]

function payload(bytes: number, seed: number): string {
  const unit = `line ${seed}: const value = compute(${seed}); // ${'pad'.repeat(10)}\n`
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes)
}

/**
 * ~5.5 MB over 110 turns. Each turn: a question; an assistant response split
 * over two rows that share one message id (text, then two parallel tool
 * calls); the two tool results, sized from 200 B to 32 KiB; a final answer.
 * Every 17th turn queues a steering message mid-turn, and turn 41 carries a
 * 1.5 MiB result (a row larger than any single read).
 */
function buildTranscript(turns = 110): object[] {
  const rand = prng(0xb0d9e7)
  const at = (s: number) => new Date(Date.UTC(2026, 0, 3, 0, 0, s)).toISOString()
  const rows: object[] = []
  let s = 0
  for (let t = 0; t < turns; t++) {
    const msgId = `msg-${t}`
    rows.push({ type: 'user', uuid: `u-${t}`, timestamp: at(s++), sessionId: SESSION, parentUuid: null, message: { role: 'user', content: `step ${t}` } })
    rows.push({ type: 'assistant', uuid: `a-${t}-0`, timestamp: at(s++), sessionId: SESSION, parentUuid: `u-${t}`, message: { id: msgId, role: 'assistant', content: [{ type: 'text', text: `working on ${t}` }] } })
    rows.push({
      type: 'assistant', uuid: `a-${t}-1`, timestamp: at(s++), sessionId: SESSION, parentUuid: `a-${t}-0`,
      message: {
        id: msgId, role: 'assistant',
        content: [
          { type: 'tool_use', id: `t-${t}-a`, name: 'Read', input: { file_path: `/w/a-${t}.ts` } },
          { type: 'tool_use', id: `t-${t}-b`, name: 'Bash', input: { command: `ls ${t}` } },
        ],
      },
    })
    if (t % 17 === 5) {
      rows.push({ type: 'attachment', uuid: `qc-raw-${t}`, timestamp: at(s++), parentUuid: null, attachment: { type: 'queued_command', commandMode: 'prompt', prompt: `steer ${t}`, source_uuid: `qc-${t}` } })
    }
    for (const leg of ['a', 'b'] as const) {
      const bytes = t === 41 && leg === 'a' ? 1.5 * MiB : 200 + Math.floor(rand() * 32 * KiB)
      rows.push({
        type: 'user', uuid: `r-${t}-${leg}`, timestamp: at(s++), sessionId: SESSION, parentUuid: `a-${t}-1`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${t}-${leg}`, content: payload(bytes, t) }] },
      })
    }
    rows.push({ type: 'assistant', uuid: `f-${t}`, timestamp: at(s++), sessionId: SESSION, parentUuid: `r-${t}-b`, message: { id: `fin-${t}`, role: 'assistant', content: [{ type: 'text', text: `done ${t}` }] } })
  }
  return rows
}

const REPLAY_SESSION = 'budget-replay-session'

/**
 * ~1 MB over 30 turns, with rows re-appended verbatim the way a resumed CLI
 * replays a little history (observed in production: a few tool results, then
 * a response's second tool-call row with its result, appended at the tail
 * megabytes after the originals). Turn 21's tool-call row returns at the
 * tail, hundreds of KiB after its original; turn 5's returns right after
 * turn 6, close enough for a 1 MiB window of the copy to hold the original.
 */
function buildReplayTranscript(): object[] {
  const rows = buildTranscript(30)
  const byUuid = new Map(rows.map((r) => [(r as { uuid: string }).uuid, r]))
  const copy = (uuid: string) => byUuid.get(uuid)!
  rows.splice(rows.indexOf(copy('f-6')) + 1, 0, copy('a-5-1'), copy('r-5-a'), copy('r-5-b'))
  rows.push(copy('r-10-b'), copy('r-15-a'), copy('a-21-1'), copy('r-21-a'), copy('r-21-b'))
  return rows
}

async function writeTranscript(sessionId: string, rows: object[]): Promise<number> {
  const sessionsDir = path.join(testDir, 'agents', AGENT, 'workspace', '.claude', 'projects', '-workspace')
  await fs.promises.mkdir(sessionsDir, { recursive: true })
  const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`)
  await fs.promises.writeFile(jsonlPath, rows.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return fs.statSync(jsonlPath).size
}

/** The oracle: the whole transcript through the same transform, the way the
 * unpaginated read serves it. */
async function fullTransform(sessionId: string): Promise<TransformedItem[]> {
  const entries = await getSessionMessagesWithCompact(createLocalSessionStore(AGENT), sessionId)
  return transformMessages(entries.filter((e) => !('isMeta' in e && e.isMeta)))
}

beforeAll(async () => {
  testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-budget-'))
  originalDataDir = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = testDir
  transcriptBytes = await writeTranscript(SESSION, buildTranscript())
  await writeTranscript(REPLAY_SESSION, buildReplayTranscript())
  full = await fullTransform(SESSION)
  replayFull = await fullTransform(REPLAY_SESSION)
})

afterAll(async () => {
  if (originalDataDir) process.env.SUPERAGENT_DATA_DIR = originalDataDir
  else delete process.env.SUPERAGENT_DATA_DIR
  await fs.promises.rm(testDir, { recursive: true, force: true })
})

interface WalkStep {
  messages: TransformedItem[]
  nextCursor: string | null
}

/** Latest page, then older pages down the cursor chain, as a client walks it. */
async function walk(
  latest: { limit: number; byteBudget?: number },
  older: { limit: number; byteBudget?: number },
  sessionId = SESSION
): Promise<WalkStep[]> {
  const store = createLocalSessionStore(AGENT)
  const steps: WalkStep[] = [await getSessionMessagesPage(store, sessionId, latest)]
  for (let i = 0; i < 500 && steps.at(-1)!.nextCursor; i++) {
    steps.push(await getSessionMessagesPage(store, sessionId, { ...older, cursor: steps.at(-1)!.nextCursor! }))
  }
  return steps
}

function expectConsistentWalk(steps: WalkStep[]): void {
  // Terminates at the transcript start.
  expect(steps.at(-1)!.nextCursor).toBeNull()
  for (const [i, step] of steps.entries()) {
    expect(step.messages.length, `page ${i} is empty`).toBeGreaterThan(0)
    // The cursor names the page's own first item…
    if (step.nextCursor !== null) expect(step.nextCursor).toBe(step.messages[0]!.id)
  }
  // …and the next page ends exactly before it: chronological concatenation
  // reproduces the full transform, with nothing skipped or repeated, and
  // every item whole (merged tool calls with their results attached).
  const walked = steps.slice().reverse().flatMap((step) => step.messages)
  expect(new Set(walked.map((m) => m.id)).size).toBe(walked.length)
  expect(walked.map((m) => m.id)).toEqual(full.map((m) => m.id))
  expect(walked).toEqual(full)
}

describe('budgeted page walks over a multi-MB transcript', () => {
  it('builds the fixture the walk needs', () => {
    expect(transcriptBytes).toBeGreaterThan(4 * MiB)
    // Merge groups really are split across rows and carry both results.
    const merged = full.find((m) => m.id === 'a-41-0')
    expect(merged).toMatchObject({ type: 'assistant' })
    expect(merged!.type === 'assistant' && merged!.toolCalls.map((tc) => tc.id)).toEqual(['t-41-a', 't-41-b'])
    expect(merged!.type === 'assistant' && merged!.toolCalls.every((tc) => tc.result !== undefined)).toBe(true)
  })

  it('iOS budgets: 512 KiB latest page, 1 MiB older pages', async () => {
    const steps = await walk({ limit: 300, byteBudget: 512 * KiB }, { limit: 200, byteBudget: 1 * MiB })
    // Bounded pages: far more than the two a 4 MiB window would take.
    expect(steps.length).toBeGreaterThan(4)
    expectConsistentWalk(steps)
  }, WALK_TIMEOUT_MS)

  it('a 1 MiB trailing page with default older pages', async () => {
    expectConsistentWalk(await walk({ limit: 300, byteBudget: 1 * MiB }, { limit: 200 }))
  }, WALK_TIMEOUT_MS)

  it('the clamp floor: 64 KiB everywhere', async () => {
    const steps = await walk({ limit: 300, byteBudget: 64 * KiB }, { limit: 200, byteBudget: 64 * KiB })
    expect(steps.length).toBeGreaterThan(20)
    expectConsistentWalk(steps)
  }, WALK_TIMEOUT_MS)

  it('no budget at all, as every client before max_bytes', async () => {
    const steps = await walk({ limit: 300 }, { limit: 200 })
    expect(steps.length).toBeGreaterThan(1)
    expectConsistentWalk(steps)
  }, WALK_TIMEOUT_MS)

  it('a small item limit inside a large budget: the item count stops the window', async () => {
    const steps = await walk({ limit: 7, byteBudget: 1 * MiB }, { limit: 5, byteBudget: 1 * MiB })
    expectConsistentWalk(steps)
    expect(Math.max(...steps.map((s) => s.messages.length))).toBeLessThanOrEqual(7)
  }, WALK_TIMEOUT_MS)

  it('serves the trailing page as a suffix of the transcript whatever the budget', async () => {
    const store = createLocalSessionStore(AGENT)
    let previous = 0
    for (const byteBudget of [64 * KiB, 512 * KiB, 1 * MiB, 4 * MiB]) {
      const page = await getSessionMessagesPage(store, SESSION, { limit: 300, byteBudget })
      expect(page.messages).toEqual(full.slice(full.length - page.messages.length))
      // A larger budget never serves less, and only a page that holds the
      // whole transcript ends the chain.
      expect(page.messages.length).toBeGreaterThanOrEqual(previous)
      previous = page.messages.length
      expect(page.nextCursor).toBe(page.messages.length < full.length ? page.messages[0]!.id : null)
    }
  }, WALK_TIMEOUT_MS)
})

describe('resume-replayed rows in a budgeted walk', () => {
  // A window can render a replayed tool-call row as an item of its own (a
  // phantom, under the row's uuid) when the response it belongs to lies
  // outside the window. The whole-file transform never does: the row merges
  // into its response, whose id is the head row's uuid.
  it('builds a fixture whose replayed rows are not items of the full transform', () => {
    const ids = new Set(replayFull.map((m) => m.id))
    expect(ids.has('a-21-0')).toBe(true)
    expect(ids.has('a-21-1')).toBe(false)
    expect(ids.has('a-5-1')).toBe(false)
    expect(ids.size).toBe(replayFull.length)
  })

  it('pages from the copy the client saw when a phantom becomes the cursor', async () => {
    const store = createLocalSessionStore(AGENT)
    const lastId = replayFull.at(-1)!.id
    // A small window of the tail copy: the original is out of reach, the copy
    // renders as the phantom, and the page is what lies older than it — the
    // transcript's real tail, not the rows older than the original.
    const near = await getSessionMessagesPage(store, REPLAY_SESSION, { limit: 200, cursor: 'a-21-1', byteBudget: 64 * KiB })
    expect(near.messages.length).toBeGreaterThan(0)
    expect(near.messages.at(-1)!.id).toBe(lastId)
    expect(near.nextCursor).toBe(near.messages[0]!.id)
    for (const item of near.messages) expect(item).toEqual(replayFull.find((m) => m.id === item.id))

    // A window that reaches the original merges the copy away; the page is
    // still everything older than the copy's position — here, the whole
    // transcript, nothing skipped between the original and the copy.
    const whole = await getSessionMessagesPage(store, REPLAY_SESSION, { limit: 200, cursor: 'a-21-1' })
    expect(whole.messages).toEqual(replayFull)
    expect(whole.nextCursor).toBeNull()

    const mid = await getSessionMessagesPage(store, REPLAY_SESSION, { limit: 200, cursor: 'a-5-1', byteBudget: 1 * MiB })
    expect(mid.messages).toEqual(replayFull.slice(0, replayFull.findIndex((m) => m.id === 'f-6') + 1))
  })

  it('a walk through a phantom cursor serves every item of the full transform once', async () => {
    // Pages of one item make the trailing phantom a page head and so a cursor.
    const steps = await walk({ limit: 1, byteBudget: 64 * KiB }, { limit: 1, byteBudget: 64 * KiB }, REPLAY_SESSION)
    expect(steps[0]!.messages.map((m) => m.id)).toEqual(['a-21-1'])
    expect(steps.at(-1)!.nextCursor).toBeNull()
    for (const [i, step] of steps.entries()) expect(step.messages.length, `page ${i} is empty`).toBe(1)

    const walked = steps.slice().reverse().flatMap((step) => step.messages)
    const fullIds = new Set(replayFull.map((m) => m.id))
    const phantoms = walked.filter((m) => !fullIds.has(m.id)).map((m) => m.id)
    expect(new Set(phantoms).size).toBe(phantoms.length)
    expect(phantoms.every((id) => id === 'a-21-1' || id === 'a-5-1')).toBe(true)
    // Every real item, once, whole, in order: the phantoms are the only extras.
    expect(walked.filter((m) => fullIds.has(m.id))).toEqual(replayFull)
  }, WALK_TIMEOUT_MS)
})
