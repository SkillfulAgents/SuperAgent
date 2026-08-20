import { describe, expect, it, vi } from 'vitest'

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }))

import { AnthropicLlmProvider } from './anthropic-provider'

describe('AnthropicLlmProvider — tool search', () => {
  // Deferred tool loading is expanded by Anthropic's own API, so this is the
  // one endpoint that needs no compatibility work.
  it('turns ENABLE_TOOL_SEARCH on', () => {
    expect(new AnthropicLlmProvider().toolSearchEnv).toBe('true')
  })
})
