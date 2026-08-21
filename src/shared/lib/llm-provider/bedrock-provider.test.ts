import { describe, expect, it, vi } from 'vitest'

vi.mock('@anthropic-ai/sdk', () => ({ default: class {} }))
vi.mock('../config/settings', () => ({ getSettings: () => ({}) }))

import { BedrockLlmProvider } from './bedrock-provider'

describe('BedrockLlmProvider — tool search', () => {
  // Bedrock serves Claude models, and the CLI's non-first-party guard never
  // fires in Bedrock mode — so unset would mean on anyway. Declared for intent.
  it('turns ENABLE_TOOL_SEARCH on', () => {
    expect(new BedrockLlmProvider().toolSearchEnv).toBe('true')
  })
})
