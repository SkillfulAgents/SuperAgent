import { describe, expect, it, vi } from 'vitest'

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }))

import { AnthropicLlmProvider } from './anthropic-provider'

describe('parseErrorResponse', () => {
  it('does not special-case a platform spend-cap body', () => {
    const parsed = new AnthropicLlmProvider().parseErrorResponse(
      429,
      'A spend cap for this workspace was reached. It resets within 30 days.',
    )
    expect(parsed).toEqual({
      severity: 'error',
      icon: 'info',
      message: '**LLM Provider Error:** A spend cap for this workspace was reached. It resets within 30 days.',
    })
  })
})

describe('AnthropicLlmProvider — tool search', () => {
  // Deferred tool loading is expanded by Anthropic's own API, so this is the
  // one endpoint that needs no compatibility work.
  it('turns ENABLE_TOOL_SEARCH on', () => {
    expect(new AnthropicLlmProvider().toolSearchEnv).toBe('true')
  })
})
