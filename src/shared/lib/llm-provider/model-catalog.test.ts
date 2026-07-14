import { describe, it, expect, vi, beforeEach } from 'vitest'

// getActiveLlmProvider / resolveModelForProvider read settings for the active
// provider id; stub settings so tests are deterministic and provider-agnostic.
const settingsMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: () => settingsMock(),
  getModelCatalogSettings: () => settingsMock().modelCatalog ?? {},
}))

import {
  getEffectiveCatalog,
  getProviderCatalog,
  getModelDefinition,
  getModelContextWindow,
  getModelPromptHints,
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
    const sonnet = catalog.find((m) => m.id === 'claude-sonnet-5')!
    expect(opus.supportedEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(sonnet.supportedEfforts).toEqual(['low', 'medium', 'high'])
  })

  it('exposes the OpenRouter non-Claude built-ins (gpt, glm, grok) with their own icons', () => {
    const catalog = getProviderCatalog('openrouter')
    const gpt = catalog.find((m) => m.id === 'openai/gpt-5.5')!
    const glm = catalog.find((m) => m.id === 'z-ai/glm-5.2')!
    const grok = catalog.find((m) => m.id === 'x-ai/grok-4.5')!
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
    expect(grok).toMatchObject({
      family: 'grok',
      isLatest: true,
      icon: 'xai',
      supportsWebSearch: false,
      pricing: { inputPerMtok: 2, outputPerMtok: 6 },
      contextWindow: 500_000,
    })
    // Anthropic must NOT inherit the OpenRouter-only extras.
    expect(getProviderCatalog('anthropic').some((m) => m.id === 'openai/gpt-5.5')).toBe(false)
    expect(getProviderCatalog('anthropic').some((m) => m.id === 'x-ai/grok-4.5')).toBe(false)
    expect(getProviderCatalog('platform').some((m) => m.id === 'x-ai/grok-4.5')).toBe(false)
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

  it('exposes the Platform GPT built-ins under BARE ids the proxy routes', () => {
    const catalog = getProviderCatalog('platform')
    const gpt = catalog.find((m) => m.id === 'gpt-5.5')!
    // gpt rides the OpenAI Responses wire, which maps native web_search.
    expect(gpt).toMatchObject({
      family: 'gpt',
      icon: 'openai',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 5, outputPerMtok: 30 },
    })
    expect(gpt.isLatest).toBeFalsy()
    // The 5.6 tiers: Sol is the flagship the bare `gpt` alias tracks.
    expect(catalog.find((m) => m.id === 'gpt-5.6-luna')).toMatchObject({
      family: 'gpt',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 1, outputPerMtok: 6 },
    })
    expect(catalog.find((m) => m.id === 'gpt-5.6-terra')).toMatchObject({
      family: 'gpt',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 2.5, outputPerMtok: 15 },
    })
    expect(catalog.find((m) => m.id === 'gpt-5.6-sol')).toMatchObject({
      family: 'gpt',
      isLatest: true,
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 5, outputPerMtok: 30 },
    })
    const gptLatest = catalog.filter((m) => m.family === 'gpt' && m.isLatest)
    expect(gptLatest.map((m) => m.id)).toEqual(['gpt-5.6-sol'])
    // Grok rides the same Responses wire (xai-responses upstream); bare id only.
    expect(catalog.find((m) => m.id === 'grok-4.5')).toMatchObject({
      family: 'grok',
      isLatest: true,
      icon: 'xai',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 2, outputPerMtok: 6 },
      contextWindow: 500_000,
    })
    // Platform keys off bare ids, never the OpenRouter vendor-prefixed slugs.
    expect(catalog.some((m) => m.id === 'openai/gpt-5.5')).toBe(false)
    expect(catalog.some((m) => m.id === 'z-ai/glm-5.2')).toBe(false)
    expect(catalog.some((m) => m.id === 'glm-5.2')).toBe(false)
    expect(catalog.some((m) => m.id === 'x-ai/grok-4.5')).toBe(false)
  })
})

describe('getEffectiveCatalog', () => {
  it('returns the built-in catalog unchanged when no overrides are configured', () => {
    expect(getEffectiveCatalog('anthropic')).toEqual(getProviderCatalog('anthropic'))
  })

  it('disables built-ins and treats unknown disables as a no-op', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [
            { id: 'claude-haiku-4-5', disabled: true },
            { id: 'missing-model', disabled: true },
          ],
        },
      },
    })

    const catalog = getEffectiveCatalog('anthropic')
    expect(catalog.some((model) => model.id === 'claude-haiku-4-5')).toBe(false)
    expect(catalog.some((model) => model.id === 'missing-model')).toBe(false)
  })

  it('shallow-patches built-ins while preserving siblings', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [
            {
              id: 'claude-opus-4-8',
              label: 'Opus patched',
              blurb: 'Fresh label',
              pricing: { inputPerMtok: 7, outputPerMtok: 31 },
            },
          ],
        },
      },
    })

    const opus = getEffectiveCatalog('anthropic').find((model) => model.id === 'claude-opus-4-8')!
    expect(opus).toMatchObject({
      label: 'Opus patched',
      blurb: 'Fresh label',
      family: 'opus',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      pricing: { inputPerMtok: 7, outputPerMtok: 31 },
    })
  })

  it('appends valid net-new models after built-ins', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [
            {
              id: 'claude-opus-4-9-custom',
              label: 'Opus 4.9 Custom',
              family: 'opus',
              icon: 'anthropic',
              supportedEfforts: ['low', 'medium', 'high'],
            },
          ],
        },
      },
    })

    const catalog = getEffectiveCatalog('anthropic')
    expect(catalog[catalog.length - 1]?.id).toBe('claude-opus-4-9-custom')
  })

  it('removes disabled custom models from the effective selectable catalog', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [
            {
              id: 'claude-opus-4-9-custom',
              label: 'Opus 4.9 Custom',
              family: 'opus',
              supportedEfforts: ['low', 'medium', 'high'],
              disabled: true,
            },
          ],
        },
      },
    })

    expect(getEffectiveCatalog('anthropic').some((model) => model.id === 'claude-opus-4-9-custom')).toBe(false)
  })

  it('keeps one entry for same-id patches and lets duplicate overrides resolve last-wins', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [
            { id: 'claude-opus-4-8', label: 'First label' },
            { id: 'claude-opus-4-8', label: 'Last label' },
          ],
        },
      },
    })

    const catalog = getEffectiveCatalog('anthropic')
    expect(catalog.filter((model) => model.id === 'claude-opus-4-8')).toHaveLength(1)
    expect(catalog.find((model) => model.id === 'claude-opus-4-8')?.label).toBe('Last label')
  })

  it('lets disabled win when a single override also contains patch fields', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [{ id: 'claude-opus-4-8', disabled: true, label: 'Hidden Opus' }],
        },
      },
    })

    expect(getEffectiveCatalog('anthropic').some((model) => model.id === 'claude-opus-4-8')).toBe(false)
  })

  it('drops and warns for structurally invalid effective entries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [
            { id: 'incomplete-custom' },
            { id: 'claude-opus-4-8', pricing: { inputPerMtok: 7 } as never },
          ],
        },
      },
    })

    const catalog = getEffectiveCatalog('anthropic')
    expect(catalog.some((model) => model.id === 'incomplete-custom')).toBe(false)
    expect(catalog.some((model) => model.id === 'claude-opus-4-8')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('normalizes family latest flags after custom and family patches', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [
            {
              id: 'claude-opus-4-9-custom',
              label: 'Opus 4.9 Custom',
              family: 'opus',
              isLatest: true,
              supportedEfforts: ['low', 'medium', 'high'],
            },
            { id: 'claude-fable-5', family: 'opus' },
          ],
        },
      },
    })

    const catalog = getEffectiveCatalog('anthropic')
    expect(catalog.filter((model) => model.family === 'opus' && model.isLatest).map((model) => model.id))
      .toEqual(['claude-opus-4-9-custom'])
  })

  it('keeps provider overrides isolated even for shared Claude catalog entries', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: { overrides: [{ id: 'claude-opus-4-8', disabled: true }] },
      },
    })

    expect(getEffectiveCatalog('anthropic').some((model) => model.id === 'claude-opus-4-8')).toBe(false)
    expect(getEffectiveCatalog('openrouter').some((model) => model.id === 'claude-opus-4-8')).toBe(true)
  })
})

describe('getModelContextWindow', () => {
  it('returns the catalog window for Platform GPT models', () => {
    expect(getModelContextWindow('gpt-5.5', 'platform')).toBe(1_050_000)
    expect(getModelContextWindow('gpt-5.4', 'platform')).toBe(1_050_000)
    expect(getModelContextWindow('gpt-5.6-sol', 'platform')).toBe(1_050_000)
  })

  it('returns the catalog window for Platform Grok models', () => {
    expect(getModelContextWindow('grok-4.5', 'platform')).toBe(500_000)
  })

  it('returns the catalog window for OpenRouter GPT models', () => {
    expect(getModelContextWindow('openai/gpt-5.5', 'openrouter')).toBe(1_050_000)
    expect(getModelContextWindow('z-ai/glm-5.2', 'openrouter')).toBeUndefined()
  })

  it('returns undefined for Claude models (SDK supplies their window)', () => {
    expect(getModelContextWindow('claude-opus-4-8', 'anthropic')).toBeUndefined()
  })

  it('returns undefined for an unknown id', () => {
    expect(getModelContextWindow('nope', 'platform')).toBeUndefined()
  })
})

describe('getModelPromptHints', () => {
  it('returns GPT-specific tool guidance for Platform and OpenRouter GPT models', () => {
    for (const [providerId, modelId] of [
      ['platform', 'gpt-5.5'],
      ['openrouter', 'openai/gpt-5.5'],
    ] as const) {
      const hints = getModelPromptHints(modelId, providerId)
      expect(hints.some((hint) => hint.includes('ToolSearch'))).toBe(true)
      expect(hints.some((hint) => hint.includes('pages as an empty string'))).toBe(true)
    }
  })

  it('returns an empty list for Claude models and unknown ids', () => {
    expect(getModelPromptHints('claude-opus-4-8', 'anthropic')).toEqual([])
    expect(getModelPromptHints('nope', 'platform')).toEqual([])
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
    expect(resolveModelForProvider('sonnet', 'anthropic', 'agent')).toBe('claude-sonnet-5')
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
    expect(resolveModelForProvider('grok', 'openrouter', 'agent')).toBe('x-ai/grok-4.5')
    expect(resolveModelForProvider('x-ai/grok-4.5', 'openrouter', 'agent')).toBe('x-ai/grok-4.5')
  })

  it('resolves Platform GPT/Grok models to bare ids and falls back for unsupported glm', () => {
    expect(resolveModelForProvider('gpt', 'platform', 'agent')).toBe('gpt-5.6-sol')
    expect(resolveModelForProvider('gpt-5.4', 'platform', 'agent')).toBe('gpt-5.4')
    expect(resolveModelForProvider('gpt-5.6-luna', 'platform', 'agent')).toBe('gpt-5.6-luna')
    expect(resolveModelForProvider('grok', 'platform', 'agent')).toBe('grok-4.5')
    expect(resolveModelForProvider('grok-4.5', 'platform', 'agent')).toBe('grok-4.5')
    expect(resolveModelForProvider('glm', 'platform', 'agent')).toBe('claude-opus-4-8')
  })

  it('resolves the SAME bare alias to each provider concrete id (cross-provider portability)', () => {
    expect(resolveModelForProvider('opus', 'anthropic', 'agent')).toBe('claude-opus-4-8')
    expect(resolveModelForProvider('opus', 'bedrock', 'agent')).toBe('us.anthropic.claude-opus-4-8')
  })

  it('falls back to the Bedrock default (concrete region id) for an Anthropic-only pin', () => {
    // An Anthropic pin that does not exist in Bedrock's catalog AND has no
    // version segment would hit the default; but a versioned unknown passes
    // through. Use a bare unknown alias to exercise the default path.
    expect(resolveModelForProvider('unknown-alias', 'bedrock', 'agent')).toBe('us.anthropic.claude-sonnet-5')
  })

  it('resolves custom model ids and custom latest aliases through the effective catalog', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [
            {
              id: 'claude-opus-4-9-custom',
              label: 'Opus 4.9 Custom',
              family: 'opus',
              isLatest: true,
              supportedEfforts: ['low', 'medium', 'high'],
            },
          ],
        },
      },
    })

    expect(resolveModelForProvider('claude-opus-4-9-custom', 'anthropic', 'agent')).toBe('claude-opus-4-9-custom')
    expect(resolveModelForProvider('opus', 'anthropic', 'agent')).toBe('claude-opus-4-9-custom')
  })

  it('handles the generic provider empty built-in catalog: resolves user-added ids, passes versioned pins, else falls back to the default', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'generic',
      modelCatalog: {
        generic: {
          overrides: [
            {
              id: 'llama3.1',
              label: 'Llama 3.1',
              supportedEfforts: ['low', 'medium', 'high'],
            },
          ],
        },
      },
    })

    // 1. A user-added id resolves exactly (it lives in the effective catalog).
    expect(resolveModelForProvider('llama3.1', 'generic', 'agent')).toBe('llama3.1')
    // 2. An unknown but versioned selection passes straight through to the SDK.
    expect(resolveModelForProvider('mixtral-8x7b', 'generic', 'agent')).toBe('mixtral-8x7b')
    // 3. An unknown alias falls back to the default — the first user-added model.
    expect(resolveModelForProvider('mystery', 'generic', 'agent')).toBe('llama3.1')
  })

  it('falls back to the generic placeholder default when no user models are configured', () => {
    settingsMock.mockReturnValue({ llmProvider: 'generic' })
    expect(resolveModelForProvider('mystery', 'generic', 'agent')).toBe('default')
  })

  it('falls back cleanly when the only latest member of a family is disabled', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [{ id: 'claude-haiku-4-5', disabled: true }],
        },
      },
    })

    expect(resolveModelForProvider('haiku', 'anthropic', 'summarizer')).toBe('haiku')
  })
})

describe('resolveActiveProviderModel', () => {
  it('resolves against the active provider from settings', () => {
    settingsMock.mockReturnValue({ llmProvider: 'bedrock' })
    expect(resolveActiveProviderModel('opus', 'agent')).toBe('us.anthropic.claude-opus-4-8')
  })
})
