import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { JsonlEntry } from '@shared/lib/types/agent'

// Hoist a mutable spy so both tests can control the return value independently
const mockCreate = vi.fn()

vi.mock('../llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({
    messages: { create: mockCreate },
  }),
}))

// loadTranscript reads JSONL off disk; stub the file layer so we can feed fixtures.
const mockReadJsonlFile = vi.fn()
vi.mock('@shared/lib/utils/file-storage', () => ({
  getSessionJsonlPath: () => '/fake/sess.jsonl',
  readJsonlFile: () => mockReadJsonlFile(),
}))

import {
  buildBranchInitialMessage, budgetedRecentSlice, loadTranscript,
  buildSeed, summarizeText, summarizeTranscript, loadTranscriptEntries,
} from './session-summary-service'
import { SUMMARY_OUTPUT_FLOOR_TOKENS, SUMMARY_OUTPUT_CAP_TOKENS } from '../stale-session/stale-session-config'
import { createSessionRequestSchema } from '../stale-session/stale-session-schema'

describe('buildBranchInitialMessage', () => {
  it('composes preamble + summary + in-container jsonl path + user message', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"summary":"Was wiring auth; just added rate limiting."}' }],
    })

    const out = await buildBranchInitialMessage({
      agentSlug: 'atlas',
      fromSessionId: 'sess-1',
      userMessage: 'add rate limiting',
      transcript: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'done' },
      ],
    })

    expect(out).toContain('Was wiring auth')                              // summary text present
    expect(out).toContain('.claude/projects/-workspace/sess-1.jsonl')    // in-container path
    expect(out).toContain('add rate limiting')                            // user message
    expect(out.toLowerCase()).toContain('continue')                       // continue-silently framing
  })

  it('parses a JSON reply wrapped in a ```json markdown fence (observed Haiku behavior)', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '```json\n{\n  "summary": "Wiring auth with rate limiting on the login route."\n}\n```' }],
    })

    const out = await buildBranchInitialMessage({
      agentSlug: 'atlas',
      fromSessionId: 'sess-1',
      userMessage: 'continue',
      transcript: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'done' },
      ],
    })

    expect(out).toContain('Wiring auth with rate limiting on the login route')
  })

  it('throws on a non-JSON model response so the caller can fall back', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'sorry I cannot do that' }],
    })

    await expect(
      buildBranchInitialMessage({
        agentSlug: 'atlas',
        fromSessionId: 'sess-1',
        userMessage: 'add rate limiting',
        transcript: [
          { role: 'user', text: 'hi' },
          { role: 'assistant', text: 'done' },
        ],
      }),
    ).rejects.toThrow(/non-JSON response/)
  })
})

describe('budgetedRecentSlice', () => {
  it('keeps at least one message even when it alone exceeds the budget', () => {
    const msgs = [{ role: 'user' as const, text: 'a'.repeat(100) }]
    // budget of 5 tokens = 20 chars; message is 100 chars (~25 tokens) — exceeds budget
    const result = budgetedRecentSlice(msgs, 5)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('a'.repeat(100))
  })

  it('trims older messages to fit the budget and returns the kept slice in chronological order', () => {
    const msgs = [
      { role: 'user' as const, text: 'aaa' },       // oldest — ~1 token
      { role: 'assistant' as const, text: 'bbb' },  // ~1 token
      { role: 'user' as const, text: 'ccc' },       // ~1 token
      { role: 'assistant' as const, text: 'ddd' },  // ~1 token (newest)
    ]
    // budget = 2 tokens (8 chars); each message is 3 chars (~1 token).
    // Walk newest-first: ddd (1 token, used=1), ccc (1 token, used=2), bbb would push to 3 > 2 and kept>0 so stop.
    // Kept: [ccc, ddd] in chronological order.
    const result = budgetedRecentSlice(msgs, 2)
    expect(result).toHaveLength(2)
    expect(result[0].text).toBe('ccc')  // older of the two kept
    expect(result[1].text).toBe('ddd')  // newest last
  })
})

describe('loadTranscript', () => {
  const userMsg = (uuid: string, text: string, extra: Record<string, unknown> = {}): JsonlEntry => ({
    uuid,
    parentUuid: null,
    type: 'user',
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: text },
    ...extra,
  }) as unknown as JsonlEntry

  const assistantMsg = (uuid: string, text: string): JsonlEntry => ({
    uuid,
    parentUuid: null,
    type: 'assistant',
    sessionId: 'sess-1',
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', content: text },
  }) as unknown as JsonlEntry

  const compactBoundary = (uuid: string): JsonlEntry => ({
    uuid,
    type: 'system',
    subtype: 'compact_boundary',
    content: '',
    isMeta: true,
    timestamp: '2026-01-01T00:00:00Z',
  }) as unknown as JsonlEntry

  it('captures the compact_boundary companion summary and excludes boilerplate entries', async () => {
    mockReadJsonlFile.mockResolvedValueOnce([
      userMsg('u1', 'hello'),
      assistantMsg('a1', 'hi there'),
      compactBoundary('s1'),
      userMsg('cs1', 'Earlier we set up auth and rate limiting.', { isCompactSummary: true }),
      // tool-result-only user message — must be excluded from the transcript
      userMsg('tr1', '', { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out' }] } }),
      userMsg('u2', 'continue please'),
    ])

    const { transcript, priorBoundarySummary } = await loadTranscript('atlas', 'sess-1')

    expect(transcript).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
      { role: 'user', text: 'continue please' },
    ])
    expect(priorBoundarySummary).toBe('Earlier we set up auth and rate limiting.')
  })

  it('returns no boundary summary when there is no compact_boundary', async () => {
    mockReadJsonlFile.mockResolvedValueOnce([
      userMsg('u1', 'just one message'),
    ])

    const { transcript, priorBoundarySummary } = await loadTranscript('atlas', 'sess-1')

    expect(transcript).toEqual([{ role: 'user', text: 'just one message' }])
    expect(priorBoundarySummary).toBeUndefined()
  })
})

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
})
