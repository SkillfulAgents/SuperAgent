import { describe, it, expect } from 'vitest'
import { AnthropicLlmProvider } from './anthropic-provider'
import { OpenRouterLlmProvider } from './openrouter-provider'
import { PlatformLlmProvider } from './platform-provider'
import { BedrockLlmProvider } from './bedrock-provider'

describe('getComposerModels', () => {
  it('Anthropic returns one entry per family with the latest pinned IDs', () => {
    const models = new AnthropicLlmProvider().getComposerModels()
    expect(models.map(m => m.family)).toEqual(['opus', 'sonnet', 'haiku'])
    expect(models.find(m => m.family === 'haiku')!.modelId).toBe('claude-haiku-4-5')
    expect(models.find(m => m.family === 'sonnet')!.modelId).toBe('claude-sonnet-4-6')
    expect(models.find(m => m.family === 'opus')!.modelId).toBe('claude-opus-4-7')
    for (const m of models) {
      expect(typeof m.label).toBe('string')
      expect(m.label.length).toBeGreaterThan(0)
    }
  })

  it('OpenRouter returns the same Anthropic-style IDs for the three families', () => {
    const models = new OpenRouterLlmProvider().getComposerModels()
    expect(models.map(m => m.family)).toEqual(['opus', 'sonnet', 'haiku'])
    expect(models.find(m => m.family === 'opus')!.modelId).toBe('claude-opus-4-7')
  })

  it('Platform returns the three families', () => {
    const models = new PlatformLlmProvider().getComposerModels()
    expect(models.map(m => m.family)).toEqual(['opus', 'sonnet', 'haiku'])
  })

  it('Bedrock returns the three families with bedrock-prefixed IDs', () => {
    const models = new BedrockLlmProvider().getComposerModels()
    expect(models.map(m => m.family)).toEqual(['opus', 'sonnet', 'haiku'])
    for (const m of models) {
      expect(m.modelId.startsWith('us.anthropic.')).toBe(true)
    }
  })
})
