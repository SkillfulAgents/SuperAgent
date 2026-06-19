import { describe, it, expect, vi, beforeEach } from 'vitest'

// getActiveLlmProvider / resolveModelForProvider read settings for the active
// provider id; stub settings so tests are deterministic and provider-agnostic.
const settingsMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: () => settingsMock(),
}))

import {
  getProviderCatalog,
  getModelDefinition,
  getModelContextWindow,
  hasVersionSegment,
  resolveModelForProvider,
} from './model-catalog'
import { resolveActiveProviderModel } from './index'

beforeEach(() => {
  settingsMock.mockReturnValue({ llmProvider: 'anthropic' })
})

describe('getProviderCatalog', () => {
  it('normalizes to at most one isLatest per family', () => {
    for (const providerId of ['anthropic', 'bedrock', 'openrouter', 'platform'] as const) {
      const catalog = getProviderCatalog(providerId)
      const latestByFamily = new Map<string, number>()
      for (const m of catalog) {
        if (m.isLatest && m.family) {
          latestByFamily.set(m.family, (latestByFamily.get(m.family) ?? 0) + 1)
        }
      }
      for (const [, count] of latestByFamily) expect(count).toBe(1)
    }
  })

  it('marks exactly one latest for the opus family (the newest)', () => {
    const catalog = getProviderCatalog('anthropic')
    const opusLatest = catalog.filter((m) => m.family === 'opus' && m.isLatest)
    expect(opusLatest).toHaveLength(1)
    expect(opusLatest[0].id).toBe('claude-opus-4-8')
  })

  it('gives Opus/Fable all five efforts and Sonnet/Haiku the lower three', () => {
    const catalog = getProviderCatalog('anthropic')
    const opus = catalog.find((m) => m.id === 'claude-opus-4-8')!
    const sonnet = catalog.find((m) => m.id === 'claude-sonnet-4-6')!
    expect(opus.supportedEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(sonnet.supportedEfforts).toEqual(['low', 'medium', 'high'])
  })

  it('exposes the OpenRouter non-Claude built-ins (gpt, glm) with their own icons', () => {
    const catalog = getProviderCatalog('openrouter')
    const gpt = catalog.find((m) => m.id === 'openai/gpt-5.5')!
    const glm = catalog.find((m) => m.id === 'z-ai/glm-5.2')!
    expect(gpt).toMatchObject({
      family: 'gpt',
      isLatest: true,
      icon: 'openai',
      pricing: { inputPerMtok: 5, outputPerMtok: 30 },
    })
    expect(glm).toMatchObject({
      family: 'glm',
      isLatest: true,
      icon: 'zai',
      pricing: { inputPerMtok: 1.2, outputPerMtok: 4.2 },
    })
    // Anthropic must NOT inherit the OpenRouter-only extras.
    expect(getProviderCatalog('anthropic').some((m) => m.id === 'openai/gpt-5.5')).toBe(false)
  })

  it('offers both GPT versions, with 5.5 the family latest and 5.4 a pinnable older version', () => {
    const catalog = getProviderCatalog('openrouter')
    const gpt54 = catalog.find((m) => m.id === 'openai/gpt-5.4')!
    expect(gpt54).toMatchObject({
      family: 'gpt',
      icon: 'openai',
      supportsWebSearch: false,
      pricing: { inputPerMtok: 2.5, outputPerMtok: 15 },
    })
    expect(gpt54.isLatest).toBeFalsy()
    const gptLatest = catalog.filter((m) => m.family === 'gpt' && m.isLatest)
    expect(gptLatest.map((m) => m.id)).toEqual(['openai/gpt-5.5'])
  })

  it('exposes the Platform non-Claude built-ins under BARE ids the proxy routes', () => {
    const catalog = getProviderCatalog('platform')
    const gpt = catalog.find((m) => m.id === 'gpt-5.5')!
    const glm = catalog.find((m) => m.id === 'glm-5.2')!
    // gpt rides the OpenAI Responses wire (native web_search), glm rides
    // Fireworks (server tools stripped → no web search).
    expect(gpt).toMatchObject({
      family: 'gpt',
      isLatest: true,
      icon: 'openai',
      supportsWebSearch: true,
      pricing: { inputPerMtok: 5, outputPerMtok: 30 },
    })
    expect(glm).toMatchObject({
      family: 'glm',
      isLatest: true,
      icon: 'zai',
      supportsWebSearch: false,
      pricing: { inputPerMtok: 1.4, outputPerMtok: 4.4 },
    })
    // Platform keys off bare ids, never the OpenRouter vendor-prefixed slugs.
    expect(catalog.some((m) => m.id === 'openai/gpt-5.5')).toBe(false)
    expect(catalog.some((m) => m.id === 'z-ai/glm-5.2')).toBe(false)
  })
})

describe('getModelContextWindow', () => {
  it('returns the catalog window for Platform non-Claude models', () => {
    expect(getModelContextWindow('gpt-5.5', 'platform')).toBe(1_050_000)
    expect(getModelContextWindow('gpt-5.4', 'platform')).toBe(1_050_000)
    expect(getModelContextWindow('glm-5.2', 'platform')).toBe(1_000_000)
  })

  it('returns the catalog window for OpenRouter non-Claude models', () => {
    expect(getModelContextWindow('openai/gpt-5.5', 'openrouter')).toBe(1_050_000)
    expect(getModelContextWindow('z-ai/glm-5.2', 'openrouter')).toBe(1_000_000)
  })

  it('returns undefined for Claude models (SDK supplies their window)', () => {
    expect(getModelContextWindow('claude-opus-4-8', 'anthropic')).toBeUndefined()
  })

  it('returns undefined for an unknown id', () => {
    expect(getModelContextWindow('nope', 'platform')).toBeUndefined()
  })
})

describe('hasVersionSegment', () => {
  it('detects a hyphen-digit version segment', () => {
    expect(hasVersionSegment('claude-opus-4-8')).toBe(true)
    expect(hasVersionSegment('us.anthropic.claude-opus-4-8')).toBe(true)
    expect(hasVersionSegment('gpt-4o')).toBe(true)
  })
  it('returns false for bare family aliases', () => {
    expect(hasVersionSegment('opus')).toBe(false)
    expect(hasVersionSegment('sonnet')).toBe(false)
  })
})

describe('getModelDefinition', () => {
  it('looks up a concrete id', () => {
    expect(getModelDefinition('claude-opus-4-7', 'anthropic')?.label).toBe('Opus 4.7')
  })
  it('returns undefined for an unknown id', () => {
    expect(getModelDefinition('nope', 'anthropic')).toBeUndefined()
  })
})

describe('resolveModelForProvider', () => {
  it('passes an exact catalog id straight through (pin)', () => {
    expect(resolveModelForProvider('claude-opus-4-7', 'anthropic', 'agent')).toBe('claude-opus-4-7')
  })

  it('resolves a bare family alias to that family latest id', () => {
    expect(resolveModelForProvider('opus', 'anthropic', 'agent')).toBe('claude-opus-4-8')
    expect(resolveModelForProvider('sonnet', 'anthropic', 'agent')).toBe('claude-sonnet-4-6')
  })

  it('passes an unknown but versioned id straight through (treated as a pin)', () => {
    expect(resolveModelForProvider('claude-opus-9-9', 'anthropic', 'agent')).toBe('claude-opus-9-9')
  })

  it('falls back to the provider default (alias-resolved) for an unknown family-less alias', () => {
    // Anthropic agent default is 'opus' → resolves to its latest concrete id.
    expect(resolveModelForProvider('mystery', 'anthropic', 'agent')).toBe('claude-opus-4-8')
    // Summarizer default 'haiku' → latest haiku.
    expect(resolveModelForProvider('mystery', 'anthropic', 'summarizer')).toBe('claude-haiku-4-5')
  })

  it('resolves OpenRouter non-Claude models (gpt alias → latest id, glm slug passthrough)', () => {
    expect(resolveModelForProvider('gpt', 'openrouter', 'agent')).toBe('openai/gpt-5.5')
    expect(resolveModelForProvider('z-ai/glm-5.2', 'openrouter', 'agent')).toBe('z-ai/glm-5.2')
  })

  it('resolves Platform non-Claude models to bare ids (gpt alias → latest, gpt-5.4 pin, glm alias)', () => {
    expect(resolveModelForProvider('gpt', 'platform', 'agent')).toBe('gpt-5.5')
    expect(resolveModelForProvider('gpt-5.4', 'platform', 'agent')).toBe('gpt-5.4')
    expect(resolveModelForProvider('glm', 'platform', 'agent')).toBe('glm-5.2')
  })

  it('resolves the SAME bare alias to each provider concrete id (cross-provider portability)', () => {
    expect(resolveModelForProvider('opus', 'anthropic', 'agent')).toBe('claude-opus-4-8')
    expect(resolveModelForProvider('opus', 'bedrock', 'agent')).toBe('us.anthropic.claude-opus-4-8')
  })

  it('falls back to the Bedrock default (concrete region id) for an Anthropic-only pin', () => {
    // An Anthropic pin that does not exist in Bedrock's catalog AND has no
    // version segment would hit the default; but a versioned unknown passes
    // through. Use a bare unknown alias to exercise the default path.
    expect(resolveModelForProvider('unknown-alias', 'bedrock', 'agent')).toBe('us.anthropic.claude-sonnet-4-6')
  })
})

describe('resolveActiveProviderModel', () => {
  it('resolves against the active provider from settings', () => {
    settingsMock.mockReturnValue({ llmProvider: 'bedrock' })
    expect(resolveActiveProviderModel('opus', 'agent')).toBe('us.anthropic.claude-opus-4-8')
  })
})
