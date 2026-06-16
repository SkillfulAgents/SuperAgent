import { describe, it, expect, vi } from 'vitest'
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

import { buildBranchInitialMessage, budgetedRecentSlice, loadTranscript } from './session-summary-service'

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
