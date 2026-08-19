/**
 * Differential tests for findLastSessionEntry.
 *
 * findLastSessionEntry reads the transcript tail instead of full-parsing the
 * file. Its contract is exact equivalence with the pre-existing path: a full
 * getSessionMessagesWithCompact parse walked backwards to the newest entry
 * matching the predicate. Every test here runs BOTH paths on the same fixture
 * and asserts identical results (the full parse is the oracle).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import {
  findLastSessionEntry,
  getSessionMessagesWithCompact,
} from './session-service'
import type { JsonlMessageEntry, JsonlSystemEntry } from '@shared/lib/types/agent'

type Entry = JsonlMessageEntry | JsonlSystemEntry
type Predicate = (entry: Entry) => boolean

const AGENT = 'tail-agent'
const SESSION = 'tail-session'

const isAssistant: Predicate = (e) => e.type === 'assistant'

const KB = 1024
const INITIAL_WINDOW = 256 * KB
const MAX_WINDOW = 4 * 1024 * KB

describe('findLastSessionEntry', () => {
  let testDir: string
  let originalEnv: string | undefined
  let sessionsDir: string

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tail-read-test-'))
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
    sessionsDir = path.join(
      testDir,
      'agents',
      AGENT,
      'workspace',
      '.claude',
      'projects',
      '-workspace'
    )
    await fs.promises.mkdir(sessionsDir, { recursive: true })
  })

  afterEach(async () => {
    if (originalEnv) {
      process.env.SUPERAGENT_DATA_DIR = originalEnv
    } else {
      delete process.env.SUPERAGENT_DATA_DIR
    }
    await fs.promises.rm(testDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function jsonlPath(): string {
    return path.join(sessionsDir, `${SESSION}.jsonl`)
  }

  async function writeTranscript(raw: string): Promise<void> {
    await fs.promises.writeFile(jsonlPath(), raw)
  }

  function userEntry(id: number, content: string): object {
    return {
      type: 'user',
      parentUuid: null,
      sessionId: SESSION,
      uuid: `user-${id}`,
      timestamp: '2026-01-24T01:00:00.000Z',
      message: { role: 'user', content },
    }
  }

  function assistantEntry(id: number, text: string): object {
    return {
      type: 'assistant',
      parentUuid: null,
      sessionId: SESSION,
      uuid: `assistant-${id}`,
      timestamp: '2026-01-24T01:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }
  }

  function toolResultEntry(id: number, payload: string): object {
    return {
      type: 'user',
      parentUuid: null,
      sessionId: SESSION,
      uuid: `tool-result-${id}`,
      timestamp: '2026-01-24T01:00:02.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t-${id}`, content: payload }],
      },
    }
  }

  function compactBoundaryEntry(id: number): object {
    return {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: `compact-${id}`,
      timestamp: '2026-01-24T01:00:03.000Z',
    }
  }

  /** A user entry padded with base64-ish payload so its JSONL line is ~`bytes` long. */
  function bigLine(id: number, bytes: number): object {
    const overhead = JSON.stringify(toolResultEntry(id, '')).length
    return toolResultEntry(id, 'A'.repeat(Math.max(0, bytes - overhead)))
  }

  function toJsonl(entries: object[]): string {
    return entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  }

  /** The pre-existing code path, run directly as the oracle. */
  async function fullParseOracle(predicate: Predicate): Promise<Entry | null> {
    const entries = await getSessionMessagesWithCompact(AGENT, SESSION)
    for (let i = entries.length - 1; i >= 0; i--) {
      if (predicate(entries[i])) return entries[i]
    }
    return null
  }

  async function expectSameAsFullParse(predicate: Predicate): Promise<Entry | null> {
    const expected = await fullParseOracle(predicate)
    const actual = await findLastSessionEntry(AGENT, SESSION, predicate)
    expect(actual).toEqual(expected)
    return actual
  }

  it('normal multi-turn transcript: picks the newest assistant entry', async () => {
    await writeTranscript(
      toJsonl([
        userEntry(1, 'first question'),
        assistantEntry(1, 'first answer'),
        userEntry(2, 'second question'),
        assistantEntry(2, 'second answer'),
      ])
    )
    const result = await expectSameAsFullParse(isAssistant)
    expect(result).toMatchObject({ uuid: 'assistant-2' })
  })

  it('limits an anchored lookup to the transcript prefix captured at completion', async () => {
    const completedTurn = toJsonl([
      userEntry(1, 'request answered by the completed turn'),
      assistantEntry(1, 'completed answer'),
    ])
    const completionOffset = Buffer.byteLength(completedTurn)
    // Give the later request an older-looking timestamp to prove the boundary
    // is transcript order, not a comparison between clock domains.
    const laterRequest = userEntry(2, 'request from the next turn') as {
      timestamp: string
    }
    laterRequest.timestamp = '2020-01-01T00:00:00.000Z'
    await writeTranscript(completedTurn + toJsonl([laterRequest]))

    const result = await findLastSessionEntry(
      AGENT,
      SESSION,
      (entry) => entry.type === 'user',
      { endOffset: completionOffset },
    )

    expect(result).toMatchObject({ uuid: 'user-1' })
  })

  it('trailing tool_result/user frames after the last assistant entry', async () => {
    await writeTranscript(
      toJsonl([
        userEntry(1, 'do a thing'),
        assistantEntry(1, 'final answer'),
        toolResultEntry(1, 'result data'),
        userEntry(2, 'stray trailing user frame'),
      ])
    )
    const result = await expectSameAsFullParse(isAssistant)
    expect(result).toMatchObject({ uuid: 'assistant-1' })
  })

  it('transcript with compaction markers: last assistant after the boundary', async () => {
    await writeTranscript(
      toJsonl([
        userEntry(1, 'old turn'),
        assistantEntry(1, 'pre-compact answer'),
        compactBoundaryEntry(1),
        userEntry(2, 'post-compact turn'),
        assistantEntry(2, 'post-compact answer'),
        toolResultEntry(2, 'trailing'),
      ])
    )
    const result = await expectSameAsFullParse(isAssistant)
    expect(result).toMatchObject({ uuid: 'assistant-2' })

    // Compact boundaries are themselves selectable entries.
    const boundary = await expectSameAsFullParse(
      (e) => e.type === 'system' && e.subtype === 'compact_boundary'
    )
    expect(boundary).toMatchObject({ uuid: 'compact-1' })
  })

  it('compaction marker AFTER the last assistant entry (compact just happened)', async () => {
    await writeTranscript(
      toJsonl([
        userEntry(1, 'turn'),
        assistantEntry(1, 'answer'),
        compactBoundaryEntry(1),
      ])
    )
    const result = await expectSameAsFullParse(isAssistant)
    expect(result).toMatchObject({ uuid: 'assistant-1' })
  })

  it('huge base64-heavy trailing lines push the assistant beyond the first window (escalation)', async () => {
    // ~600KB of trailing tool results: not in the 256KB window, found at 1MB.
    await writeTranscript(
      toJsonl([
        userEntry(1, 'screenshot please'),
        assistantEntry(1, 'took the screenshots'),
        bigLine(1, 200 * KB),
        bigLine(2, 200 * KB),
        bigLine(3, 200 * KB),
      ])
    )
    const openSpy = vi.spyOn(fs.promises, 'open')
    const result = await expectSameAsFullParse(isAssistant)
    expect(result).toMatchObject({ uuid: 'assistant-1' })
    // Escalated exactly once (256KB miss → 1MB hit); the oracle's own full
    // parse accounts for the third open.
    expect(openSpy).toHaveBeenCalledTimes(3)
  })

  it('huge single line larger than the initial window (no complete line in window)', async () => {
    await writeTranscript(
      toJsonl([
        userEntry(1, 'big output'),
        assistantEntry(1, 'summarized'),
        bigLine(1, 300 * KB),
      ])
    )
    const result = await expectSameAsFullParse(isAssistant)
    expect(result).toMatchObject({ uuid: 'assistant-1' })
  })

  it('assistant only at the very start of a >4MB file: escalates to cap, then full-parse fallback', async () => {
    const filler: object[] = []
    for (let i = 0; i < 6; i++) filler.push(bigLine(i, 900 * KB)) // ~5.4MB
    await writeTranscript(toJsonl([assistantEntry(1, 'only answer'), ...filler]))

    const openSpy = vi.spyOn(fs.promises, 'open')
    const result = await findLastSessionEntry(AGENT, SESSION, isAssistant)
    // 3 tail windows (256KB, 1MB, 4MB — all miss) + 1 full-parse fallback.
    expect(openSpy).toHaveBeenCalledTimes(4)
    expect(result).toMatchObject({ uuid: 'assistant-1' })
    expect(result).toEqual(await fullParseOracle(isAssistant))
  })

  it('match misses capped windows but file smaller than cap: found without fallback', async () => {
    const filler: object[] = []
    for (let i = 0; i < 2; i++) filler.push(bigLine(i, 900 * KB)) // ~1.8MB, < 4MB cap
    await writeTranscript(toJsonl([assistantEntry(1, 'early answer'), ...filler]))

    const openSpy = vi.spyOn(fs.promises, 'open')
    const result = await findLastSessionEntry(AGENT, SESSION, isAssistant)
    // 256KB miss → 1MB miss → 4MB window covers the whole file and hits.
    expect(openSpy).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ uuid: 'assistant-1' })
    expect(result).toEqual(await fullParseOracle(isAssistant))
  })

  it('no assistant entry at all: null, decided from a whole-file window without fallback', async () => {
    await writeTranscript(toJsonl([userEntry(1, 'hello?'), toolResultEntry(1, 'noise')]))
    const openSpy = vi.spyOn(fs.promises, 'open')
    const result = await findLastSessionEntry(AGENT, SESSION, isAssistant)
    expect(result).toBeNull()
    // Small file: first window covers it entirely — one read, no fallback.
    expect(openSpy).toHaveBeenCalledTimes(1)
    expect(await fullParseOracle(isAssistant)).toBeNull()
  })

  it('no assistant entry in a large file: null equals the oracle', async () => {
    const filler: object[] = []
    for (let i = 0; i < 6; i++) filler.push(bigLine(i, 900 * KB))
    await writeTranscript(toJsonl(filler))
    await expectSameAsFullParse(isAssistant)
  })

  it('empty file: null', async () => {
    await writeTranscript('')
    expect(await expectSameAsFullParse(isAssistant)).toBeNull()
  })

  it('missing file: null', async () => {
    expect(await expectSameAsFullParse(isAssistant)).toBeNull()
  })

  it('file ending without a trailing newline: last line still parsed', async () => {
    const raw = toJsonl([userEntry(1, 'q'), assistantEntry(1, 'a')]).slice(0, -1)
    expect(raw.endsWith('\n')).toBe(false)
    await writeTranscript(raw)
    const result = await expectSameAsFullParse(isAssistant)
    expect(result).toMatchObject({ uuid: 'assistant-1' })
  })

  it('partial (mid-write) last line: skipped by both paths', async () => {
    const raw =
      toJsonl([userEntry(1, 'q'), assistantEntry(1, 'complete answer')]) +
      '{"type":"assistant","mess'
    await writeTranscript(raw)
    const result = await expectSameAsFullParse(isAssistant)
    expect(result).toMatchObject({ uuid: 'assistant-1' })
  })

  it('queued_command attachment entries are normalized in the tail path too', async () => {
    await writeTranscript(
      toJsonl([
        userEntry(1, 'start'),
        assistantEntry(1, 'working'),
        {
          type: 'attachment',
          uuid: 'attach-1',
          parentUuid: 'assistant-1',
          sessionId: SESSION,
          timestamp: '2026-01-24T01:00:04.000Z',
          attachment: {
            type: 'queued_command',
            commandMode: 'prompt',
            prompt: 'queued follow-up',
            source_uuid: 'queued-1',
          },
        },
      ])
    )
    const isUser: Predicate = (e) => e.type === 'user'
    const result = await expectSameAsFullParse(isUser)
    expect(result).toMatchObject({
      type: 'user',
      uuid: 'queued-1',
      isQueuedCommand: true,
    })
    // And the assistant walk still skips over the attachment-derived entry.
    await expectSameAsFullParse(isAssistant)
  })

  it('window offset landing exactly on a line boundary still equals the oracle', async () => {
    // Build a suffix whose byte length is exactly the initial window, so the
    // tail read starts precisely at a line start and discards one complete
    // line. The discarded line is a filler user entry; the assistant target
    // sits later in the window.
    const tailEntries = [
      userEntry(2, 'second turn'),
      assistantEntry(2, 'target answer'),
      toolResultEntry(2, 'trailing'),
    ]
    const tailFixed = toJsonl(tailEntries)
    const boundaryLineTarget = INITIAL_WINDOW - tailFixed.length - 1 // -1 for its own '\n'
    const boundaryLine = JSON.stringify(bigLine(99, boundaryLineTarget)) + '\n'
    // bigLine pads to an exact byte length; verify the arithmetic held.
    const suffix = boundaryLine + tailFixed
    expect(Buffer.byteLength(suffix)).toBe(INITIAL_WINDOW)

    const prefix = toJsonl([userEntry(1, 'first turn'), assistantEntry(1, 'decoy answer')])
    await writeTranscript(prefix + suffix)

    const result = await expectSameAsFullParse(isAssistant)
    expect(result).toMatchObject({ uuid: 'assistant-2' })
  })

  it('assistant entry exactly at the discarded first line of the window: escalation recovers it', async () => {
    // The newest assistant line IS the first line of the initial window: the
    // first attempt discards it (complete-line discard case) and finds only
    // trailing noise, so escalation must recover the same entry the full
    // parse selects.
    const assistantLine = JSON.stringify(assistantEntry(7, 'boundary answer')) + '\n'
    const noiseLine =
      JSON.stringify(bigLine(98, INITIAL_WINDOW - assistantLine.length - 1)) + '\n'
    const suffix = assistantLine + noiseLine
    expect(Buffer.byteLength(suffix)).toBe(INITIAL_WINDOW)

    const prefix = toJsonl([userEntry(1, 'first turn')])
    await writeTranscript(prefix + suffix)
    // Sanity: the initial window starts exactly at the assistant line.
    const size = (await fs.promises.stat(jsonlPath())).size
    expect(size - INITIAL_WINDOW).toBe(Buffer.byteLength(prefix))

    const result = await expectSameAsFullParse(isAssistant)
    expect(result).toMatchObject({ uuid: 'assistant-7' })
  })

  it('window sizes: escalation stays within the documented cap', () => {
    // Guard the constants this suite's fixtures are built around.
    expect(INITIAL_WINDOW * 4 * 4).toBe(MAX_WINDOW)
  })
})
