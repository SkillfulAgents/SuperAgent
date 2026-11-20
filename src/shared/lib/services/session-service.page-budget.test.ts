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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { getSessionMessagesPage, getSessionMessagesWithCompact } from './session-service'
import { createLocalSessionStore } from '@shared/lib/agent-actor/local-session-store'
import { prng } from '@shared/lib/agent-actor/testing/prng'
import { transformMessages, type TransformedItem } from '@shared/lib/utils/message-transform'
import { cursorId } from './testing/page-cursor'
import { deriveTaskList } from '@shared/lib/utils/derive-task-list'
import { startsVisibleTurn } from '@shared/lib/utils/visible-turn-start'

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

/** Line-start offsets of a row and its copies, oldest first: the original,
 * then each copy a resume replay appended. */
async function rowCopyOffsets(sessionId: string, uuid: string): Promise<number[]> {
  const sessionsDir = path.join(testDir, 'agents', AGENT, 'workspace', '.claude', 'projects', '-workspace')
  const text = await fs.promises.readFile(path.join(sessionsDir, `${sessionId}.jsonl`), 'utf-8')
  let offset = 0
  const offsets: number[] = []
  for (const line of text.split('\n')) {
    if (line && (JSON.parse(line) as { uuid?: string }).uuid === uuid) offsets.push(offset)
    offset += Buffer.byteLength(line) + 1
  }
  return offsets
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
  latest: { limit: number; byteBudget?: number; softBudget?: { bytes: number; minTurns: number } },
  older: { limit: number; byteBudget?: number; softBudget?: { bytes: number; minTurns: number } },
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
    if (step.nextCursor !== null) expect(cursorId(step.nextCursor)).toBe(step.messages[0]!.id)
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
      expect(cursorId(page.nextCursor)).toBe(page.messages.length < full.length ? page.messages[0]!.id : null)
    }
  }, WALK_TIMEOUT_MS)
})

// What the web renderer sends for its trailing page: a lower budget that may
// cut the page only once it holds a number of whole turns.
describe('a soft budget with a turn floor', () => {
  const turnStarts = (items: TransformedItem[]) =>
    items.filter((m) => m.type === 'user' && !m.queued).length

  async function trailing(opts: { softBudget?: { bytes: number; minTurns: number }; byteBudget?: number }, sessionId = SESSION) {
    return getSessionMessagesPage(createLocalSessionStore(AGENT), sessionId, { limit: 300, ...opts })
  }

  it('serves a suffix of the default page that holds its turns, for every floor', async () => {
    const byDefault = await trailing({})
    // ~4 MiB of ~50 KiB turns: more turns than any floor below 60.
    expect(turnStarts(byDefault.messages)).toBeGreaterThan(60)
    let previous = 0
    for (const minTurns of [1, 5, 10, 40, 60]) {
      const page = await trailing({ softBudget: { bytes: 1 * MiB, minTurns } })
      const at = `min_turns ${minTurns}`
      expect(page.messages.length, at).toBeGreaterThan(0)
      expect(page.messages, at).toEqual(byDefault.messages.slice(byDefault.messages.length - page.messages.length))
      expect(page.messages.length, at).toBeLessThan(byDefault.messages.length)
      expect(turnStarts(page.messages), at).toBeGreaterThanOrEqual(minTurns)
      expect(cursorId(page.nextCursor), at).toBe(page.messages[0]!.id)
      expect(page.messages.length, at).toBeGreaterThanOrEqual(previous)
      previous = page.messages.length
    }
  }, WALK_TIMEOUT_MS)

  it('cuts at the bytes once the turns are there, and at the turn when they are not', async () => {
    const plain = await trailing({ byteBudget: 1 * MiB })
    // 1 MiB already holds more than ten turns: the floor changes nothing.
    expect(turnStarts(plain.messages)).toBeGreaterThan(10)
    expect((await trailing({ softBudget: { bytes: 1 * MiB, minTurns: 10 } })).messages).toEqual(plain.messages)
    // Forty turns are about 2 MiB: the page runs on to the fortieth turn's
    // question and starts there, a whole turn.
    const floored = await trailing({ softBudget: { bytes: 1 * MiB, minTurns: 40 } })
    expect(turnStarts(floored.messages)).toBe(40)
    expect(floored.messages[0]).toMatchObject({ type: 'user', id: 'u-70' })
  }, WALK_TIMEOUT_MS)

  it('is the default page when the default window holds fewer turns than the floor', async () => {
    const byDefault = await trailing({})
    const page = await trailing({ softBudget: { bytes: 1 * MiB, minTurns: 100 } })
    expect(turnStarts(byDefault.messages)).toBeLessThan(100)
    expect(page).toEqual(byDefault)
  }, WALK_TIMEOUT_MS)

  it('does not count a message queued mid-turn as a turn', async () => {
    // Turn 107 holds a queued steering message (107 % 17 === 5).
    const page = await trailing({ softBudget: { bytes: 64 * KiB, minTurns: 4 } })
    expect(page.messages.some((m) => m.type === 'user' && m.queued)).toBe(true)
    expect(turnStarts(page.messages)).toBeGreaterThanOrEqual(4)
    expect(page.messages[0]!.type).toBe('user')
  }, WALK_TIMEOUT_MS)

  it('chains into older pages with nothing skipped or repeated', async () => {
    const soft = { softBudget: { bytes: 1 * MiB, minTurns: 10 } }
    // The web mix: a soft trailing page, default older pages.
    expectConsistentWalk(await walk({ limit: 300, ...soft }, { limit: 200 }))
    // A floor that places every page boundary, and one the item limit beats.
    const small = { softBudget: { bytes: 64 * KiB, minTurns: 3 } }
    expectConsistentWalk(await walk({ limit: 300, ...small }, { limit: 200, ...small }))
    expectConsistentWalk(await walk({ limit: 7, ...soft }, { limit: 5, ...soft }))
  }, WALK_TIMEOUT_MS)

  it('leaves a transcript smaller than the budget whole', async () => {
    await writeTranscript('soft-small', buildTranscript(6))
    const whole = await fullTransform('soft-small')
    const page = await trailing({ softBudget: { bytes: 1 * MiB, minTurns: 10 } }, 'soft-small')
    expect(page).toEqual({ messages: whole, nextCursor: null })
    expect(page).toEqual(await trailing({}, 'soft-small'))
  })

  it('serves a huge trailing result whole, with the turns before it', async () => {
    // Twelve small turns, then a turn whose tool result alone is 2 MiB: twice
    // the soft budget, in the newest rows of the file.
    const rows = buildTranscript(12)
    rows.push(
      { type: 'user', uuid: 'u-big', timestamp: '2026-01-03T01:00:00.000Z', sessionId: SESSION, parentUuid: null, message: { role: 'user', content: 'read the dump' } },
      { type: 'assistant', uuid: 'a-big', timestamp: '2026-01-03T01:00:01.000Z', sessionId: SESSION, parentUuid: 'u-big', message: { id: 'msg-big', role: 'assistant', content: [{ type: 'tool_use', id: 't-big', name: 'Read', input: { file_path: '/w/dump' } }] } },
      { type: 'user', uuid: 'r-big', timestamp: '2026-01-03T01:00:02.000Z', sessionId: SESSION, parentUuid: 'a-big', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-big', content: payload(2 * MiB, 999) }] } },
      { type: 'assistant', uuid: 'f-big', timestamp: '2026-01-03T01:00:03.000Z', sessionId: SESSION, parentUuid: 'r-big', message: { id: 'fin-big', role: 'assistant', content: [{ type: 'text', text: 'read it' }] } },
    )
    await writeTranscript('soft-big-tail', rows)
    const whole = await fullTransform('soft-big-tail')
    const page = await trailing({ softBudget: { bytes: 1 * MiB, minTurns: 10 } }, 'soft-big-tail')
    expect(page.messages).toEqual(whole.slice(whole.length - page.messages.length))
    expect(page.messages.at(-1)!.id).toBe('f-big')
    const call = page.messages.find((m) => m.id === 'a-big')
    expect(call?.type === 'assistant' && call.toolCalls[0]!.result).toBeTruthy()
    // The big turn and nine before it: the page starts on a question.
    expect(turnStarts(page.messages)).toBe(10)
    expect(page.messages[0]).toMatchObject({ type: 'user', id: 'u-3' })
    expect(cursorId(page.nextCursor)).toBe('u-3')

    // The same turn alone in a transcript: all of it.
    await writeTranscript('soft-only-big', rows.slice(-4))
    const only = await trailing({ softBudget: { bytes: 1 * MiB, minTurns: 10 } }, 'soft-only-big')
    expect(only.messages.map((m) => m.id)).toEqual(['u-big', 'a-big', 'f-big'])
    expect(only.nextCursor).toBeNull()
  }, WALK_TIMEOUT_MS)

  // The turns the floor counts are the ones the message list draws. A user
  // row the list hides (a `[SYSTEM]` notice) or folds must not stand in for
  // one: ten notices after a large result made a page with nothing to show.
  describe('counts only turns the message list draws', () => {
    const visibleStarts = (items: TransformedItem[]) =>
      items.filter((m) => m.type === 'user' && !m.queued && startsVisibleTurn(m.content.text)).length
    const stamp = (n: number) => new Date(Date.UTC(2026, 0, 4, 0, 0, n)).toISOString()
    const user = (uuid: string, n: number, content: string) =>
      ({ type: 'user', uuid, timestamp: stamp(n), sessionId: SESSION, parentUuid: null, message: { role: 'user', content } })

    function bigTurn(n: number): object[] {
      return [
        user('u-big', n, 'read the dump'),
        { type: 'assistant', uuid: 'a-big', timestamp: stamp(n + 1), sessionId: SESSION, parentUuid: 'u-big', message: { id: 'msg-big', role: 'assistant', content: [{ type: 'tool_use', id: 't-big', name: 'Read', input: { file_path: '/w/dump' } }] } },
        { type: 'user', uuid: 'r-big', timestamp: stamp(n + 2), sessionId: SESSION, parentUuid: 'a-big', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-big', content: payload(1.2 * MiB, 7) }] } },
        { type: 'assistant', uuid: 'f-big', timestamp: stamp(n + 3), sessionId: SESSION, parentUuid: 'r-big', message: { id: 'fin-big', role: 'assistant', content: [{ type: 'text', text: 'read it' }] } },
      ]
    }

    it.each([
      ['system notices', (i: number) => `[SYSTEM] Slack: message ${i} arrived in #general`],
      ['stop markers', () => '[Request interrupted by user]'],
      ['local command output', (i: number) => `<local-command-stdout>ran ${i}</local-command-stdout>`],
      ['/compact commands', () => '/compact'],
    ])('ten %s after a large result do not make the page', async (name, text) => {
      const session = `soft-hidden-${name.replace(/\W+/g, '-')}`
      const rows = [...buildTranscript(20), ...bigTurn(0)]
      for (let i = 0; i < 10; i++) rows.push(user(`hidden-${i}`, 10 + i, text(i)))
      await writeTranscript(session, rows)
      const whole = await fullTransform(session)

      const page = await trailing({ softBudget: { bytes: 1 * MiB, minTurns: 10 } }, session)
      expect(page.messages).toEqual(whole.slice(whole.length - page.messages.length))
      // The big turn's question and nine before it, all of them bubbles.
      expect(visibleStarts(page.messages)).toBe(10)
      expect(page.messages[0]).toMatchObject({ type: 'user', id: 'u-11' })
      expect(page.messages.length).toBeLessThan(whole.length)
    }, WALK_TIMEOUT_MS)

    it('does not count a message queued mid-turn or a monitor notification', async () => {
      const rows = [...buildTranscript(20), ...bigTurn(0)]
      for (let i = 0; i < 10; i++) {
        rows.push({ type: 'attachment', uuid: `q-raw-${i}`, timestamp: stamp(10 + i), parentUuid: null, attachment: { type: 'queued_command', commandMode: 'prompt', prompt: `steer ${i}`, source_uuid: `q-${i}` } })
      }
      await writeTranscript('soft-hidden-queued', rows)
      const page = await trailing({ softBudget: { bytes: 1 * MiB, minTurns: 10 } }, 'soft-hidden-queued')
      expect(visibleStarts(page.messages)).toBe(10)
      expect(page.messages[0]).toMatchObject({ type: 'user', id: 'u-11' })
    }, WALK_TIMEOUT_MS)
  })

  // The activity card builds its task list from the page: a TaskUpdate names
  // a task by the id its TaskCreate's result reported. A page that holds the
  // update and not the create dropped a task the default page showed.
  describe('holds the TaskCreate of every TaskUpdate in the page', () => {
    const stamp = (n: number) => new Date(Date.UTC(2026, 0, 5, 0, 0, n)).toISOString()
    let n = 0
    const call = (uuid: string, id: string, name: string, input: object) =>
      ({ type: 'assistant', uuid, timestamp: stamp(n++), sessionId: SESSION, parentUuid: null, message: { id: `msg-${uuid}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
    const result = (uuid: string, id: string, content: string) =>
      ({ type: 'user', uuid, timestamp: stamp(n++), sessionId: SESSION, parentUuid: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } })
    const ask = (uuid: string, content: string) =>
      ({ type: 'user', uuid, timestamp: stamp(n++), sessionId: SESSION, parentUuid: null, message: { role: 'user', content } })

    /** A planning turn that creates two tasks, `between` ~50 KiB turns, then a turn that updates `taskId`. */
    function taskTranscript(between: number, taskId: string | null): object[] {
      return [
        ask('u-plan', 'plan the migration'),
        call('c-1', 'tc-1', 'TaskCreate', { subject: 'Export the data', activeForm: 'Exporting the data' }),
        result('cr-1', 'tc-1', 'Task #1 created successfully: Export the data'),
        call('c-2', 'tc-2', 'TaskCreate', { subject: 'Import the data', activeForm: 'Importing the data' }),
        result('cr-2', 'tc-2', 'Task #2 created successfully: Import the data'),
        ...buildTranscript(between),
        ask('u-go', 'start'),
        ...(taskId === null ? [] : [
          call('up-1', 'tu-1', 'TaskUpdate', { taskId, status: 'in_progress' }),
          result('ur-1', 'tu-1', `Updated task #${taskId} status`),
        ]),
        { type: 'assistant', uuid: 'f-go', timestamp: stamp(n++), sessionId: SESSION, parentUuid: null, message: { id: 'fin-go', role: 'assistant', content: [{ type: 'text', text: 'on it' }] } },
      ]
    }

    it('extends past the budget to the create, and shows the task the default page shows', async () => {
      // Forty turns, ~2 MiB, between the creates and the update: well past
      // 1 MiB and ten turns, inside the default page.
      await writeTranscript('soft-tasks', taskTranscript(40, '1'))
      const byDefault = await trailing({}, 'soft-tasks')
      const page = await trailing({ softBudget: { bytes: 1 * MiB, minTurns: 10 } }, 'soft-tasks')
      expect(deriveTaskList(byDefault.messages).activeItem).toMatchObject({ content: 'Export the data', status: 'in_progress' })
      expect(deriveTaskList(page.messages)).toEqual(deriveTaskList(byDefault.messages))
      expect(page.messages.map((m) => m.id)).toContain('c-1')
      expect(page.messages).toEqual(byDefault.messages.slice(byDefault.messages.length - page.messages.length))
    }, WALK_TIMEOUT_MS)

    it('stays short when no update in the page names an older task', async () => {
      await writeTranscript('soft-tasks-idle', taskTranscript(40, null))
      const page = await trailing({ softBudget: { bytes: 1 * MiB, minTurns: 10 } }, 'soft-tasks-idle')
      expect(page.messages.map((m) => m.id)).not.toContain('c-1')
      expect(page.messages.length).toBeLessThan((await trailing({}, 'soft-tasks-idle')).messages.length)
    }, WALK_TIMEOUT_MS)

    it('is the default page when the create cannot be reached', async () => {
      // The update names a task no row creates (compacted away): the soft
      // budget never applies, so the page is what it was without it.
      await writeTranscript('soft-tasks-orphan', taskTranscript(100, '99'))
      const byDefault = await trailing({}, 'soft-tasks-orphan')
      expect(await trailing({ softBudget: { bytes: 1 * MiB, minTurns: 10 } }, 'soft-tasks-orphan')).toEqual(byDefault)
      expect(byDefault.nextCursor).not.toBeNull()
    }, WALK_TIMEOUT_MS)

    it('keeps the create out of the sacrificed head position', async () => {
      // The creates are the oldest rows the page needs, for every distance
      // between them and the update.
      for (const between of [11, 12, 20, 21, 33]) {
        const session = `soft-tasks-${between}`
        await writeTranscript(session, [...buildTranscript(5), ...taskTranscript(between, '2')])
        const page = await trailing({ softBudget: { bytes: 64 * KiB, minTurns: 1 } }, session)
        expect(deriveTaskList(page.messages).activeItem, `between ${between}`).toMatchObject({ content: 'Import the data' })
      }
    }, WALK_TIMEOUT_MS)
  })
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
    expect(cursorId(near.nextCursor)).toBe(near.messages[0]!.id)
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

  it('serves the same pages for a phantom cursor whether it seeks or scans', async () => {
    // A seek anchors on the copy the client saw, so it splits the window at
    // that copy without the id scan's second pass and its warning.
    const store = createLocalSessionStore(AGENT)
    const cases = [
      { uuid: 'a-21-1', byteBudget: 64 * KiB },
      { uuid: 'a-21-1', byteBudget: undefined },
      { uuid: 'a-5-1', byteBudget: 1 * MiB },
    ]
    for (const { uuid, byteBudget } of cases) {
      const budget = byteBudget !== undefined ? { byteBudget } : {}
      const scanned = await getSessionMessagesPage(store, REPLAY_SESSION, { limit: 200, cursor: uuid, ...budget })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const cursor = `${uuid}:${(await rowCopyOffsets(REPLAY_SESSION, uuid)).at(-1)}`
      const seeked = await getSessionMessagesPage(store, REPLAY_SESSION, { limit: 200, cursor, ...budget })
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
      expect(seeked.messages).toEqual(scanned.messages)
      expect(cursorId(seeked.nextCursor)).toBe(cursorId(scanned.nextCursor))
    }
  })

  it('splits a seek at the copy it anchored on when the row was replayed twice', async () => {
    // Two resumes replay turn 2's tool-call row: after turn 5, then after
    // turn 6. A cursor on the first copy pages what lies older than that
    // copy. Turn 6 lies between the copies: newer, and already served.
    const rows = buildTranscript(8)
    const row = (uuid: string) => rows.find((r) => (r as { uuid: string }).uuid === uuid)!
    rows.splice(rows.indexOf(row('f-5')) + 1, 0, row('a-2-1'))
    rows.splice(rows.indexOf(row('f-6')) + 1, 0, row('a-2-1'))
    await writeTranscript('twice-replayed', rows)
    const whole = await fullTransform('twice-replayed')
    const [, firstCopy] = await rowCopyOffsets('twice-replayed', 'a-2-1')

    const page = await getSessionMessagesPage(createLocalSessionStore(AGENT), 'twice-replayed', {
      limit: 200,
      cursor: `a-2-1:${firstCopy}`,
    })
    expect(page.messages).toEqual(whole.slice(0, whole.findIndex((m) => m.id === 'f-5') + 1))
  })

  it('walks the replayed transcript to its start at a range of page sizes', async () => {
    // Offset cursors, as the server hands them out. A page can repeat items
    // (a copy first, its original later), so the check is on what a client
    // shows after it drops the repeats: every real item, in order.
    const fullIds = replayFull.map((m) => m.id)
    for (const byteBudget of [64 * KiB, 1 * MiB]) {
      for (const limit of [2, 3, 5, 8, 13, 50]) {
        const at = `limit ${limit}, budget ${byteBudget}`
        const steps = await walk({ limit, byteBudget }, { limit, byteBudget }, REPLAY_SESSION)
        expect(steps.at(-1)!.nextCursor, at).toBeNull()
        let shown: string[] = []
        for (const [i, step] of steps.entries()) {
          expect(step.messages.length, `${at}: page ${i} is empty`).toBeGreaterThan(0)
          shown = [...step.messages.map((m) => m.id).filter((id) => !shown.includes(id)), ...shown]
        }
        expect(shown.filter((id) => fullIds.includes(id)), at).toEqual(fullIds)
      }
    }
  }, WALK_TIMEOUT_MS)

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
