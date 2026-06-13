import { describe, it, expect } from 'vitest'
import { AnthropicLlmProvider } from './anthropic-provider'
import { OpenRouterLlmProvider } from './openrouter-provider'
import { PlatformLlmProvider } from './platform-provider'
import { BedrockLlmProvider } from './bedrock-provider'

describe('getComposerModels', () => {
  // Wire format is the family alias for every provider — the agent container
  // collapses any pinned/region-prefixed ID to the alias before the SDK call,
  // so storing the alias is functionally equivalent and removes the lookup
  // dance at call sites. See agent-container/src/claude-code.ts:263.

  it('Anthropic returns one entry per family with modelId === family', () => {
    const models = new AnthropicLlmProvider().getComposerModels()
    expect(models.map(m => m.family)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    for (const m of models) {
      expect(m.modelId).toBe(m.family)
      expect(m.label.length).toBeGreaterThan(0)
    }
  })

  it('OpenRouter returns family aliases as modelIds', () => {
    const models = new OpenRouterLlmProvider().getComposerModels()
    expect(models.map(m => m.modelId)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })

  it('Platform returns family aliases as modelIds', () => {
    const models = new PlatformLlmProvider().getComposerModels()
    expect(models.map(m => m.modelId)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })

  it('Bedrock returns family aliases as modelIds (collapsed by container before SDK call)', () => {
    const models = new BedrockLlmProvider().getComposerModels()
    expect(models.map(m => m.modelId)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })
})
