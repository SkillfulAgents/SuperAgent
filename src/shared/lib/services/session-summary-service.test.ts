import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoist a mutable spy so both tests can control the return value independently
const mockCreate = vi.fn()

vi.mock('../llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({
    messages: { create: mockCreate },
  }),
}))

// loadTranscriptEntries reads JSONL off disk; stub the file layer so we can feed fixtures.
const mockReadJsonlFile = vi.fn()
vi.mock('@shared/lib/utils/file-storage', () => ({
  getSessionJsonlPath: () => '/fake/sess.jsonl',
  readJsonlFile: () => mockReadJsonlFile(),
}))

import {
  buildSeed, summarizeText, summarizeTranscript, loadTranscriptEntries,
} from './session-summary-service'
import { SUMMARY_OUTPUT_FLOOR_TOKENS, SUMMARY_OUTPUT_CAP_TOKENS, BRANCH_PREAMBLE_SENTINEL } from '../stale-session/stale-session-config'
import { createSessionRequestSchema, summarizeRequestSchema, summarizeResponseSchema } from '../stale-session/stale-session-schema'

describe('buildSeed', () => {
  it('composes sentinel + summary + in-container path line + anti-recap + user message', () => {
    const out = buildSeed({
      fromSessionId: 'sess-1',
      summary: '## Goal\nWiring auth.',
      userMessage: 'add rate limiting',
    })
    expect(out).toContain('## Goal')
    expect(out).toContain('.claude/projects/-workspace/sess-1.jsonl')
    expect(out.toLowerCase()).toContain('do not recap')
    expect(out).toContain('\n---\n')
    expect(out.endsWith('add rate limiting')).toBe(true)
  })

  it('keeps the genuine path line last even when the summary contains a fake one', () => {
    // The splitter anchors on the LAST -workspace/<id>.jsonl line, then the first ---
    // after it. A summary that embeds a fake path + --- must not hijack the split.
    const out = buildSeed({
      fromSessionId: 'real-1',
      summary: 'earlier I read .claude/projects/-workspace/fake.jsonl\n---\nnot the real separator',
      userMessage: 'go',
    })
    const lines = out.split('\n')
    let lastPath = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('.claude/projects/-workspace/')) { lastPath = i; break }
    }
    expect(lines[lastPath]).toContain('real-1.jsonl')
    const sepAfter = lines.findIndex((l, i) => i > lastPath && l === '---')
    expect(sepAfter).toBeGreaterThan(lastPath)
    expect(lines.slice(sepAfter + 1).join('\n')).toBe('go')
  })

  it('emits the exact load-bearing shape (guards against reordering or wording drift)', () => {
    const out = buildSeed({
      fromSessionId: 'sess-9',
      summary: '## Goal\nShip it.',
      userMessage: 'continue',
    })
    expect(out).toBe(
      [
        `${BRANCH_PREAMBLE_SENTINEL} The summary below covers the earlier context.`,
        '',
        '## Goal\nShip it.',
        '',
        'If you need exact details (code, errors), read the full transcript at: .claude/projects/-workspace/sess-9.jsonl',
        'Continue directly from where it left off. Do not recap or acknowledge this summary.',
        '',
        '---',
        'continue',
      ].join('\n'),
    )
  })
})

describe('summarizeText', () => {
  beforeEach(() => { mockCreate.mockReset(); mockReadJsonlFile.mockReset() })

  it('returns the model markdown directly with no JSON parsing', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '## Goal\nFix login bug.\n## Next steps\nAdd a test.' }],
    })
    const out = await summarizeText('USER: fix login\nASSISTANT: on it')
    expect(out).toBe('## Goal\nFix login bug.\n## Next steps\nAdd a test.')
  })

  it('requests max_tokens within the clamp bounds', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
    await summarizeText('short input')
    const maxTokens = mockCreate.mock.calls[0][0].max_tokens
    expect(maxTokens).toBeGreaterThanOrEqual(SUMMARY_OUTPUT_FLOOR_TOKENS)
    expect(maxTokens).toBeLessThanOrEqual(SUMMARY_OUTPUT_CAP_TOKENS)
  })

  it('returns empty string when model response has no text block', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }],
    })
    const out = await summarizeText('some transcript text')
    expect(out).toBe('')
  })

  it('concatenates multiple text blocks', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Part A' }, { type: 'text', text: ' Part B' }],
    })
    const out = await summarizeText('some input')
    expect(out).toBe('Part A Part B')
  })

  it('treats a text block with no text field as empty (no "undefined" leaks in)', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text' }, { type: 'text', text: 'real' }],
    })
    const out = await summarizeText('some input')
    expect(out).toBe('real')
  })

  it('includes [Earlier summary] prefix in prompt when priorBoundarySummary is provided', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
    await summarizeText('transcript text', 'The auth flow was set up.')
    const sentContent = mockCreate.mock.calls[0][0].messages[0].content as string
    expect(sentContent).toContain('[Earlier summary]\nThe auth flow was set up.')
  })

  it('omits [Earlier summary] prefix when priorBoundarySummary is absent', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
    await summarizeText('transcript text')
    const sentContent = mockCreate.mock.calls[0][0].messages[0].content as string
    expect(sentContent).not.toContain('[Earlier summary]')
  })

  it('clamps max_tokens to floor for a tiny input', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
    await summarizeText('x')
    const maxTokens = mockCreate.mock.calls[0][0].max_tokens
    expect(maxTokens).toBe(SUMMARY_OUTPUT_FLOOR_TOKENS)
  })

  it('clamps max_tokens to cap for a very large input', async () => {
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
    await summarizeText('a'.repeat(60_000))
    const maxTokens = mockCreate.mock.calls[0][0].max_tokens
    expect(maxTokens).toBe(SUMMARY_OUTPUT_CAP_TOKENS)
  })
})

describe('summarizeTranscript', () => {
  beforeEach(() => { mockCreate.mockReset(); mockReadJsonlFile.mockReset() })

  it('feeds the LLM a pruned activity view (tool traces, not raw dumps)', async () => {
    mockReadJsonlFile.mockResolvedValueOnce([
      { uuid: 'u1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        message: { role: 'user', content: 'fix login' } },
      { uuid: 'a1', parentUuid: null, type: 'assistant', sessionId: 's', timestamp: 't',
        message: { role: 'assistant', content: [
          { type: 'text', text: 'patching' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/auth.ts' } },
        ] } },
    ])
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: '## Goal\nLogin.' }] })

    const summary = await summarizeTranscript('atlas', 'sess-1')

    expect(summary).toBe('## Goal\nLogin.')
    const sentContent = mockCreate.mock.calls[0][0].messages[0].content as string
    expect(sentContent).toContain('[tool] Edit src/auth.ts')
  })

  it('threads priorBoundarySummary from the transcript into the LLM prompt', async () => {
    mockReadJsonlFile.mockResolvedValueOnce([
      { uuid: 's1', type: 'system', subtype: 'compact_boundary', content: '', isMeta: true, timestamp: 't' },
      { uuid: 'cs1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        isCompactSummary: true, message: { role: 'user', content: 'Auth was set up earlier.' } },
      { uuid: 'u1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        message: { role: 'user', content: 'continue' } },
    ])
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'done' }] })
    await summarizeTranscript('atlas', 'sess-1')
    const sentContent = mockCreate.mock.calls[0][0].messages[0].content as string
    expect(sentContent).toContain('[Earlier summary]')
    expect(sentContent).toContain('Auth was set up earlier.')
  })

  it('still calls summarizeText when all entries prune to nothing', async () => {
    mockReadJsonlFile.mockResolvedValueOnce([
      { uuid: 's1', type: 'system', subtype: 'compact_boundary', content: '', isMeta: true, timestamp: 't' },
    ])
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: '' }] })
    await summarizeTranscript('atlas', 'sess-1')
    expect(mockCreate).toHaveBeenCalledOnce()
    const call = mockCreate.mock.calls[0][0]
    expect(call.messages).toHaveLength(1)
    expect(call.messages[0].role).toBe('user')
  })
})

describe('loadTranscriptEntries', () => {
  beforeEach(() => { mockCreate.mockReset(); mockReadJsonlFile.mockReset() })

  it('returns raw entries plus the prior compact_boundary summary', async () => {
    mockReadJsonlFile.mockResolvedValueOnce([
      { uuid: 's1', type: 'system', subtype: 'compact_boundary', content: '', isMeta: true, timestamp: 't' },
      { uuid: 'cs1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        isCompactSummary: true, message: { role: 'user', content: 'Earlier: set up auth.' } },
      { uuid: 'u1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        message: { role: 'user', content: 'continue' } },
    ])
    const { entries, priorBoundarySummary } = await loadTranscriptEntries('atlas', 'sess-1')
    expect(entries).toHaveLength(3)
    expect(priorBoundarySummary).toBe('Earlier: set up auth.')
  })

  it('returns undefined when companion isCompactSummary sits beyond the 3-entry lookahead', async () => {
    mockReadJsonlFile.mockResolvedValueOnce([
      { uuid: 's1', type: 'system', subtype: 'compact_boundary', content: '', isMeta: true, timestamp: 't' },
      { uuid: 'u1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        message: { role: 'user', content: 'a' } },
      { uuid: 'u2', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        message: { role: 'user', content: 'b' } },
      { uuid: 'u3', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        message: { role: 'user', content: 'c' } },
      // companion at offset 4 — beyond the j <= i+3 window
      { uuid: 'cs1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        isCompactSummary: true, message: { role: 'user', content: 'Late summary.' } },
    ])
    const { priorBoundarySummary } = await loadTranscriptEntries('atlas', 'sess-1')
    expect(priorBoundarySummary).toBeUndefined()
  })

  it('returns undefined when compact_boundary has no isCompactSummary companion', async () => {
    mockReadJsonlFile.mockResolvedValueOnce([
      { uuid: 's1', type: 'system', subtype: 'compact_boundary', content: '', isMeta: true, timestamp: 't' },
      { uuid: 'u1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        message: { role: 'user', content: 'no companion here' } },
    ])
    const { priorBoundarySummary } = await loadTranscriptEntries('atlas', 'sess-1')
    expect(priorBoundarySummary).toBeUndefined()
  })

  it('returns undefined when isCompactSummary companion has empty text', async () => {
    mockReadJsonlFile.mockResolvedValueOnce([
      { uuid: 's1', type: 'system', subtype: 'compact_boundary', content: '', isMeta: true, timestamp: 't' },
      { uuid: 'cs1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        isCompactSummary: true, message: { role: 'user', content: '' } },
    ])
    const { priorBoundarySummary } = await loadTranscriptEntries('atlas', 'sess-1')
    expect(priorBoundarySummary).toBeUndefined()
  })

  it('uses the latest valid companion when multiple compact_boundaries exist', async () => {
    mockReadJsonlFile.mockResolvedValueOnce([
      { uuid: 's1', type: 'system', subtype: 'compact_boundary', content: '', isMeta: true, timestamp: 't' },
      { uuid: 'cs1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        isCompactSummary: true, message: { role: 'user', content: 'First summary.' } },
      { uuid: 'u1', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        message: { role: 'user', content: 'continue' } },
      { uuid: 's2', type: 'system', subtype: 'compact_boundary', content: '', isMeta: true, timestamp: 't' },
      { uuid: 'cs2', parentUuid: null, type: 'user', sessionId: 's', timestamp: 't',
        isCompactSummary: true, message: { role: 'user', content: 'Second summary.' } },
    ])
    const { priorBoundarySummary } = await loadTranscriptEntries('atlas', 'sess-1')
    expect(priorBoundarySummary).toBe('Second summary.')
  })
})

describe('createSessionRequestSchema', () => {
  it('rejects a whitespace-only message', () => {
    expect(createSessionRequestSchema.safeParse({ message: '   ' }).success).toBe(false)
  })
  it('rejects seedSummary without fromSessionId (and vice versa)', () => {
    expect(createSessionRequestSchema.safeParse({ message: 'hi', seedSummary: 's' }).success).toBe(false)
    expect(createSessionRequestSchema.safeParse({ message: 'hi', fromSessionId: 'sess-1' }).success).toBe(false)
  })
  it('accepts both together', () => {
    expect(createSessionRequestSchema.safeParse({ message: 'hi', seedSummary: 's', fromSessionId: 'sess-1' }).success).toBe(true)
  })
  it('rejects fromSessionId with invalid charset', () => {
    expect(createSessionRequestSchema.safeParse({ message: 'hi', seedSummary: 's', fromSessionId: '../x' }).success).toBe(false)
    expect(createSessionRequestSchema.safeParse({ message: 'hi', seedSummary: 's', fromSessionId: 'a/b' }).success).toBe(false)
  })
})

describe('summarizeRequestSchema', () => {
  it('rejects fromSessionId with path traversal or slash characters', () => {
    expect(summarizeRequestSchema.safeParse({ fromSessionId: '../x' }).success).toBe(false)
    expect(summarizeRequestSchema.safeParse({ fromSessionId: 'a/b' }).success).toBe(false)
  })
  it('accepts a valid alphanumeric session id', () => {
    expect(summarizeRequestSchema.safeParse({ fromSessionId: 'abc-123_XYZ' }).success).toBe(true)
  })
})

describe('summarizeResponseSchema', () => {
  it('rejects an empty summary', () => {
    expect(summarizeResponseSchema.safeParse({ summary: '' }).success).toBe(false)
  })
  it('rejects a whitespace-only summary', () => {
    expect(summarizeResponseSchema.safeParse({ summary: '   \n\t ' }).success).toBe(false)
  })
  it('accepts a non-empty summary', () => {
    expect(summarizeResponseSchema.safeParse({ summary: '## Goal\nFix bug.' }).success).toBe(true)
  })
})
