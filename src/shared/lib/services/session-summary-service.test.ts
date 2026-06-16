import { describe, it, expect, vi } from 'vitest'

// Hoist a mutable spy so both tests can control the return value independently
const mockCreate = vi.fn()

vi.mock('../llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({
    messages: { create: mockCreate },
  }),
}))

import { buildBranchInitialMessage, budgetedRecentSlice } from './session-summary-service'

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
