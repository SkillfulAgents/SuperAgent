/**
 * Differential tests for the streaming transcript rewrite in removeMessage /
 * removeToolCall.
 *
 * The previous implementation parsed the whole transcript, filtered it, and
 * rewrote every line via JSON.stringify — costing 3-4x the file size in peak
 * memory and re-serializing (i.e. potentially re-formatting) every byte of the
 * file. The streaming implementation must make the SAME keep/drop/modify
 * decisions, while copying every untouched line through byte-for-byte.
 *
 * Each test runs the OLD implementation as an in-test oracle over the same
 * input and asserts the new on-disk result is semantically identical, plus
 * byte-fidelity properties the old implementation did not have.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { removeMessage, removeToolCall } from './session-service'

// ---------------------------------------------------------------------------
// Oracle: the previous implementation, verbatim logic, operating on a raw
// transcript string. Returns the rewritten content, or null for "not found"
// (in which case the old code left the file untouched).
// ---------------------------------------------------------------------------

type AnyEntry = Record<string, any>

function oracleParseJsonl(content: string): AnyEntry[] {
  const results: AnyEntry[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      results.push(JSON.parse(trimmed))
    } catch {
      // old behavior: skip malformed lines
    }
  }
  return results
}

function oracleRemoveMessage(content: string, messageUuid: string): string | null {
  const entries = oracleParseJsonl(content)

  const matchesTargetId = (e: AnyEntry): boolean =>
    ('uuid' in e && e.uuid === messageUuid) ||
    (e.type === 'attachment' && e.attachment?.source_uuid === messageUuid)

  const target = entries.find(matchesTargetId)
  if (!target) return null

  const messageIdsToRemove = new Set<string>()
  const toolUseIdsToRemove = new Set<string>()

  if (target.type === 'assistant' && target.message.id) {
    messageIdsToRemove.add(target.message.id)
    for (const entry of entries) {
      if (!('message' in entry)) continue
      if (entry.type === 'assistant' && entry.message.id === target.message.id) {
        const blocks = entry.message.content
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block.type === 'tool_use') toolUseIdsToRemove.add(block.id)
          }
        }
      }
    }
  }

  const filtered = entries.filter((entry) => {
    if (matchesTargetId(entry)) return false
    if (!('uuid' in entry)) return true
    if (entry.type === 'assistant' && entry.message.id && messageIdsToRemove.has(entry.message.id))
      return false
    if (entry.type === 'user' && toolUseIdsToRemove.size > 0) {
      const blocks = entry.message.content
      if (Array.isArray(blocks)) {
        if (
          blocks.every(
            (b: AnyEntry) => b.type === 'tool_result' && toolUseIdsToRemove.has(b.tool_use_id)
          )
        ) {
          return false
        }
      }
    }
    return true
  })

  return filtered.map((e) => JSON.stringify(e)).join('\n') + (filtered.length > 0 ? '\n' : '')
}

function oracleRemoveToolCall(content: string, toolCallId: string): string | null {
  const entries = oracleParseJsonl(content)
  let found = false
  const filtered: AnyEntry[] = []

  for (const entry of entries) {
    if (!('message' in entry)) {
      filtered.push(entry)
      continue
    }
    if (entry.type === 'user' && Array.isArray(entry.message.content)) {
      const blocks = entry.message.content
      const remaining = blocks.filter(
        (b: AnyEntry) => !(b.type === 'tool_result' && b.tool_use_id === toolCallId)
      )
      if (remaining.length < blocks.length) {
        found = true
        if (remaining.length === 0) continue
        filtered.push({ ...entry, message: { ...entry.message, content: remaining } })
        continue
      }
    }
    if (entry.type === 'assistant' && Array.isArray(entry.message.content)) {
      const blocks = entry.message.content
      const remaining = blocks.filter(
        (b: AnyEntry) => !(b.type === 'tool_use' && b.id === toolCallId)
      )
      if (remaining.length < blocks.length) {
        found = true
        if (remaining.length === 0) continue
        filtered.push({ ...entry, message: { ...entry.message, content: remaining } })
        continue
      }
    }
    filtered.push(entry)
  }

  if (!found) return null
  return filtered.map((e) => JSON.stringify(e)).join('\n') + (filtered.length > 0 ? '\n' : '')
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function userEntry(uuid: string, text: string): AnyEntry {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: 'sess-1',
    timestamp: '2026-01-24T01:00:00.000Z',
    message: { role: 'user', content: text },
  }
}

function assistantEntry(uuid: string, messageId: string, blocks: AnyEntry[]): AnyEntry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    sessionId: 'sess-1',
    timestamp: '2026-01-24T01:00:01.000Z',
    message: { role: 'assistant', content: blocks, id: messageId },
  }
}

function toolResultEntry(uuid: string, toolUseId: string, result: string): AnyEntry {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId: 'sess-1',
    timestamp: '2026-01-24T01:00:02.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result }],
    },
  }
}

/** Lines exercising bytes that a parse-and-restringify pass would NOT
 *  round-trip: non-canonical spacing, unicode escapes, float formatting. */
const NON_CANONICAL_LINES = [
  '{"type": "user",  "uuid": "spaced-1", "message": {"role": "user", "content": "caf\\u00e9"}, "sortWeight": 1.0}',
  '{"type":"user","uuid":"unicode-1","message":{"role":"user","content":"héllo 🌍 日本語 \\"quoted\\" back\\\\slash"}}',
]

/** A tool-free filler transcript body of roughly `bytes` bytes. */
function fillerLines(bytes: number, prefix: string): string[] {
  const lines: string[] = []
  const text = 'x'.repeat(2048)
  let total = 0
  let i = 0
  while (total < bytes) {
    const line = JSON.stringify(userEntry(`${prefix}-${i++}`, text))
    lines.push(line)
    total += line.length + 1
  }
  return lines
}

const longBase64Line = JSON.stringify(
  userEntry('base64-1', Buffer.from('binary'.repeat(400000)).toString('base64'))
)

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

describe('transcript rewrite (streaming) vs previous implementation', () => {
  let testDir: string
  let originalEnv: string | undefined
  let sessionsDir: string

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'transcript-rewrite-test-'))
    originalEnv = process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DATA_DIR = testDir
    sessionsDir = path.join(testDir, 'agents', 'test-agent', 'workspace', '.claude', 'projects', '-workspace')
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

  function jsonlPath(sessionId: string): string {
    return path.join(sessionsDir, `${sessionId}.jsonl`)
  }

  async function writeTranscript(sessionId: string, raw: string): Promise<void> {
    await fs.promises.writeFile(jsonlPath(sessionId), raw)
  }

  async function readTranscript(sessionId: string): Promise<string> {
    return fs.promises.readFile(jsonlPath(sessionId), 'utf-8')
  }

  async function listTempFiles(): Promise<string[]> {
    const names = await fs.promises.readdir(sessionsDir)
    return names.filter((n) => n.endsWith('.tmp'))
  }

  /**
   * Core differential assertion:
   *  - the new on-disk result parses to the same entries as the oracle output
   *  - every output line that is not an expected modification appears
   *    byte-identically in the input (untouched lines are never re-serialized)
   */
  function assertDifferential(
    inputRaw: string,
    actualRaw: string,
    oracleRaw: string,
    opts: { allowModifiedLine?: (line: string) => boolean } = {}
  ): void {
    expect(oracleParseJsonl(actualRaw)).toEqual(oracleParseJsonl(oracleRaw))
    const inputLines = new Set(inputRaw.split('\n'))
    for (const line of actualRaw.split('\n')) {
      if (line === '') continue
      if (inputLines.has(line)) continue
      if (opts.allowModifiedLine?.(line)) continue
      throw new Error(`output line was re-serialized (not byte-identical to input): ${line.slice(0, 120)}`)
    }
  }

  // -------------------------------------------------------------------------
  // removeMessage
  // -------------------------------------------------------------------------

  describe('removeMessage', () => {
    function buildTranscript(targetPosition: 'start' | 'middle' | 'end'): string {
      const target = JSON.stringify(userEntry('target-uuid', 'delete me'))
      const front = fillerLines(1_500_000, 'front')
      const back = fillerLines(1_500_000, 'back')
      const middle = [...NON_CANONICAL_LINES, longBase64Line]
      const lines =
        targetPosition === 'start'
          ? [target, ...front, ...middle, ...back]
          : targetPosition === 'end'
            ? [...front, ...middle, ...back, target]
            : [...front, ...middle, target, ...back]
      return lines.join('\n') + '\n'
    }

    for (const position of ['start', 'middle', 'end'] as const) {
      it(`matches the old implementation on a multi-MB transcript (target at ${position})`, async () => {
        const input = buildTranscript(position)
        await writeTranscript('sess-1', input)

        const oracle = oracleRemoveMessage(input, 'target-uuid')
        expect(oracle).not.toBeNull()

        const result = await removeMessage('test-agent', 'sess-1', 'target-uuid')
        expect(result).toBe(true)

        const actual = await readTranscript('sess-1')
        assertDifferential(input, actual, oracle!)
        // The non-canonical lines were untouched, so their exact original
        // bytes must survive (the old implementation would have normalized
        // them — proving the rewrite no longer re-serializes kept lines).
        for (const line of NON_CANONICAL_LINES) {
          expect(actual.includes(line)).toBe(true)
        }
        expect(await listTempFiles()).toEqual([])
      })
    }

    it('removes an assistant message spanning multiple entries plus its tool_results, like the old implementation', async () => {
      const lines = [
        JSON.stringify(userEntry('user-1', 'hi')),
        // Streamed assistant turn: two entries share message.id, each with a tool_use
        JSON.stringify(
          assistantEntry('asst-1-part-1', 'msg-1', [
            { type: 'text', text: 'part one' },
            { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
          ])
        ),
        JSON.stringify(
          assistantEntry('asst-1-part-2', 'msg-1', [
            { type: 'tool_use', id: 'tc-2', name: 'Read', input: { file: 'a.txt' } },
          ])
        ),
        JSON.stringify(toolResultEntry('tr-1', 'tc-1', 'out-1')),
        JSON.stringify(toolResultEntry('tr-2', 'tc-2', 'out-2')),
        JSON.stringify(assistantEntry('asst-2', 'msg-2', [{ type: 'text', text: 'done' }])),
        ...NON_CANONICAL_LINES,
      ]
      const input = lines.join('\n') + '\n'
      await writeTranscript('sess-1', input)

      const oracle = oracleRemoveMessage(input, 'asst-1-part-1')
      const result = await removeMessage('test-agent', 'sess-1', 'asst-1-part-1')
      expect(result).toBe(true)

      const actual = await readTranscript('sess-1')
      assertDifferential(input, actual, oracle!)
      const remainingUuids = oracleParseJsonl(actual).map((e) => e.uuid)
      expect(remainingUuids).toEqual(['user-1', 'asst-2', 'spaced-1', 'unicode-1'])
    })

    it('removes a queued message by attachment source_uuid, like the old implementation', async () => {
      const attachment = {
        type: 'attachment',
        uuid: 'attachment-entry-uuid',
        parentUuid: 'user-1',
        sessionId: 'sess-1',
        timestamp: '2026-01-24T01:00:05.000Z',
        attachment: {
          type: 'queued_command',
          prompt: [{ type: 'text', text: 'Queued steer' }],
          source_uuid: 'queue-source-uuid',
          commandMode: 'prompt',
        },
      }
      const lines = [JSON.stringify(userEntry('user-1', 'start')), JSON.stringify(attachment)]
      const input = lines.join('\n') + '\n'
      await writeTranscript('sess-1', input)

      const oracle = oracleRemoveMessage(input, 'queue-source-uuid')
      const result = await removeMessage('test-agent', 'sess-1', 'queue-source-uuid')
      expect(result).toBe(true)
      assertDifferential(input, await readTranscript('sess-1'), oracle!)
    })

    it('handles a file without a trailing newline (adds one, same as the old implementation)', async () => {
      const lines = [
        JSON.stringify(userEntry('user-1', 'first')),
        JSON.stringify(userEntry('target-uuid', 'delete me')),
        JSON.stringify(userEntry('user-3', 'last')),
      ]
      const input = lines.join('\n') // no trailing newline
      await writeTranscript('sess-1', input)

      const oracle = oracleRemoveMessage(input, 'target-uuid')
      const result = await removeMessage('test-agent', 'sess-1', 'target-uuid')
      expect(result).toBe(true)

      const actual = await readTranscript('sess-1')
      expect(actual).toBe(oracle) // identical here: kept lines were canonical
      expect(actual.endsWith('\n')).toBe(true)
    })

    it('returns false and leaves the file byte-identical when the uuid is not found', async () => {
      const input = [...NON_CANONICAL_LINES, JSON.stringify(userEntry('user-1', 'hi'))].join('\n') + '\n'
      await writeTranscript('sess-1', input)

      const result = await removeMessage('test-agent', 'sess-1', 'nonexistent-uuid')
      expect(result).toBe(false)
      expect(await readTranscript('sess-1')).toBe(input)
      expect(await listTempFiles()).toEqual([])
    })

    it('preserves blank and malformed (mid-write) lines byte-for-byte', async () => {
      // Deliberate difference from the old implementation, which silently
      // DROPPED blank/malformed lines on every rewrite. Malformed lines are
      // usually a concurrent SDK write in progress; discarding them was a
      // destructive side effect, not a feature. The streaming rewrite copies
      // them through untouched.
      const malformed = '{"type":"user","uuid":"truncated-'
      const input = [
        JSON.stringify(userEntry('user-1', 'keep me')),
        '',
        malformed,
        JSON.stringify(userEntry('target-uuid', 'delete me')),
      ].join('\n') + '\n'
      await writeTranscript('sess-1', input)

      const result = await removeMessage('test-agent', 'sess-1', 'target-uuid')
      expect(result).toBe(true)

      const actual = await readTranscript('sess-1')
      expect(actual.split('\n')).toContain(malformed)
      expect(actual.split('\n')).toContain('')
      expect(oracleParseJsonl(actual).map((e) => e.uuid)).toEqual(['user-1'])
    })

    it('cleans up the temp file and leaves the original untouched when the rewrite fails', async () => {
      const input = [
        JSON.stringify(userEntry('user-1', 'hi')),
        JSON.stringify(userEntry('target-uuid', 'delete me')),
      ].join('\n') + '\n'
      await writeTranscript('sess-1', input)

      const err = Object.assign(new Error('injected rename failure'), { code: 'EIO' })
      const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValue(err)
      try {
        await expect(removeMessage('test-agent', 'sess-1', 'target-uuid')).rejects.toThrow(
          'injected rename failure'
        )
      } finally {
        renameSpy.mockRestore()
      }

      expect(await readTranscript('sess-1')).toBe(input)
      expect(await listTempFiles()).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // removeToolCall
  // -------------------------------------------------------------------------

  describe('removeToolCall', () => {
    it('strips the tool_use block and drops the tool_result entry, matching the old implementation', async () => {
      const lines = [
        JSON.stringify(userEntry('user-1', 'hi')),
        JSON.stringify(
          assistantEntry('asst-1', 'msg-1', [
            { type: 'text', text: 'running a tool' },
            { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
          ])
        ),
        JSON.stringify(toolResultEntry('tr-1', 'tc-1', 'out')),
        ...NON_CANONICAL_LINES,
        longBase64Line,
      ]
      const input = lines.join('\n') + '\n'
      await writeTranscript('sess-1', input)

      const oracle = oracleRemoveToolCall(input, 'tc-1')
      const result = await removeToolCall('test-agent', 'sess-1', 'tc-1')
      expect(result).toBe(true)

      const actual = await readTranscript('sess-1')
      // The assistant line is legitimately modified (tool_use stripped);
      // everything else must be byte-identical to the input.
      assertDifferential(input, actual, oracle!, {
        allowModifiedLine: (line) => JSON.parse(line).uuid === 'asst-1',
      })
      for (const line of NON_CANONICAL_LINES) {
        expect(actual.includes(line)).toBe(true)
      }
      expect(actual.includes(longBase64Line)).toBe(true)
      expect(await listTempFiles()).toEqual([])
    })

    it('drops entries whose content becomes empty, matching the old implementation', async () => {
      const lines = [
        JSON.stringify(userEntry('user-1', 'hi')),
        JSON.stringify(
          assistantEntry('asst-1', 'msg-1', [
            { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
          ])
        ),
        JSON.stringify(toolResultEntry('tr-1', 'tc-1', 'out')),
      ]
      const input = lines.join('\n') + '\n'
      await writeTranscript('sess-1', input)

      const oracle = oracleRemoveToolCall(input, 'tc-1')
      const result = await removeToolCall('test-agent', 'sess-1', 'tc-1')
      expect(result).toBe(true)

      const actual = await readTranscript('sess-1')
      assertDifferential(input, actual, oracle!)
      expect(oracleParseJsonl(actual).map((e) => e.uuid)).toEqual(['user-1'])
    })

    it('returns false and leaves the file byte-identical when the tool call is not found', async () => {
      const input = [...NON_CANONICAL_LINES, JSON.stringify(userEntry('user-1', 'hi'))].join('\n') + '\n'
      await writeTranscript('sess-1', input)

      const result = await removeToolCall('test-agent', 'sess-1', 'nonexistent-tc')
      expect(result).toBe(false)
      expect(await readTranscript('sess-1')).toBe(input)
      expect(await listTempFiles()).toEqual([])
    })

    it('matches the old implementation on a multi-MB transcript', async () => {
      const lines = [
        ...fillerLines(2_000_000, 'front'),
        JSON.stringify(
          assistantEntry('asst-1', 'msg-1', [
            { type: 'text', text: 'keep this text' },
            { type: 'tool_use', id: 'tc-1', name: 'Bash', input: { command: 'ls' } },
          ])
        ),
        JSON.stringify(toolResultEntry('tr-1', 'tc-1', 'out')),
        ...fillerLines(2_000_000, 'back'),
      ]
      const input = lines.join('\n') + '\n'
      await writeTranscript('sess-1', input)

      const oracle = oracleRemoveToolCall(input, 'tc-1')
      const result = await removeToolCall('test-agent', 'sess-1', 'tc-1')
      expect(result).toBe(true)

      assertDifferential(input, await readTranscript('sess-1'), oracle!, {
        allowModifiedLine: (line) => JSON.parse(line).uuid === 'asst-1',
      })
    })
  })
})
