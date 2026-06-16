import { describe, it, expect, vi } from 'vitest'

// Hoist a mutable spy so both tests can control the return value independently
const mockCreate = vi.fn()

vi.mock('../llm-provider/helpers', () => ({
  getConfiguredLlmClient: () => ({
    messages: { create: mockCreate },
  }),
}))

import { buildBranchInitialMessage } from './session-summary-service'

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

  it('throws on a malformed model response (Zod) so the caller can fall back', async () => {
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
    ).rejects.toThrow()
  })
})
