import { describe, it, expect, vi, beforeEach } from 'vitest'

// getActiveLlmProvider / resolveModelForProvider read settings for the active
// provider id; stub settings so tests are deterministic and provider-agnostic.
const settingsMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: async () => settingsMock(),
}))

import {
  getEffectiveCatalog,
  getProviderCatalog,
  getModelDefinition,
  getModelContextWindow,
  getModelContextWindowMap,
  getModelPromptHints,
  hasVersionSegment,
  resolveModelForProvider,
} from './model-catalog'
import { getAllProviderInfo, getLlmProvider, resolveActiveProviderModel } from './index'

beforeEach(() => {
  settingsMock.mockReturnValue({ llmProvider: 'anthropic' })
})

describe('getProviderCatalog', () => {
  it('exposes provider-owned onboarding options and uses Sonnet as the Platform agent fallback', async () => {
    const platform = (await getAllProviderInfo()).find((provider) => provider.id === 'platform')!

    expect(platform.defaultModelOptions.map((option) => option.model)).toEqual([
      'opus',
      'sonnet',
      'gpt-sol',
      'grok',
    ])
    expect(platform.defaultModels.agent).toBe('sonnet')
    expect(getLlmProvider('platform').getDefaultModel('agent')).toBe('sonnet')
  })

  it('declares one concrete picker default for every built-in model vendor', async () => {
    const defaultsByIcon = (providerId: 'anthropic' | 'bedrock' | 'openrouter' | 'platform') =>
      getProviderCatalog(providerId)
        .filter((model) => model.isDefault)
        .map((model) => [model.icon, model.id])

    expect(defaultsByIcon('anthropic')).toEqual([
      ['anthropic', 'claude-opus-5-5'],
    ])
    expect(defaultsByIcon('bedrock')).toEqual([
      ['anthropic', 'us.anthropic.claude-opus-4-8'],
    ])
    expect(defaultsByIcon('openrouter')).toEqual([
      ['anthropic', 'claude-opus-5-5'],
      ['openai', 'openai/gpt-5.5'],
      ['zai', 'z-ai/glm-5.2'],
      ['xai', 'x-ai/grok-4.7'],
      ['kimi', 'moonshotai/kimi-k3'],
    ])
    expect(defaultsByIcon('platform')).toEqual([
      ['anthropic', 'claude-opus-5-5'],
      ['openai', 'gpt-6.1-sol'],
      ['xai', 'grok-4.7'],
      ['gemini', 'gemini-4-argon'],
      ['kimi', 'kimi-k3'],
      ['meta', 'muse-wonder-1.0'],
      ['zai', 'glm-5.3-flash'],
      ['deepseek', 'deepseek-v4.1-flash'],
    ])
  })

  it('normalizes to at most one isLatest per family', async () => {
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

  it('marks exactly one latest for the opus family (the newest)', async () => {
    const catalog = getProviderCatalog('anthropic')
    const opusLatest = catalog.filter((m) => m.family === 'opus' && m.isLatest)
    expect(opusLatest).toHaveLength(1)
    expect(opusLatest[0].id).toBe('claude-opus-5-5')
  })

  it('keeps Opus 5 selectable but demoted once Opus 5.5 takes the family alias', async () => {
    for (const providerId of ['anthropic', 'openrouter', 'platform'] as const) {
      const catalog = getProviderCatalog(providerId)
      const opus5 = catalog.find((m) => m.id === 'claude-opus-5')!
      expect(opus5).toMatchObject({ family: 'opus', label: 'Opus 5' })
      expect(opus5.isLatest).toBeFalsy()
      expect(opus5.isDefault).toBeFalsy()
      expect(catalog.find((m) => m.id === 'claude-opus-5-5')).toMatchObject({
        family: 'opus',
        label: 'Opus 5.5',
        isLatest: true,
        isDefault: true,
        pricing: { inputPerMtok: 4, outputPerMtok: 20, speedMultipliers: { fast: 2 } },
      })
    }
  })

  it('resolves the fable alias to Fable 5.2 and keeps Fable 5.1 selectable', async () => {
    for (const providerId of ['anthropic', 'openrouter', 'platform'] as const) {
      const catalog = getProviderCatalog(providerId)
      expect(catalog.find((m) => m.id === 'claude-fable-5-1')!.isLatest).toBeFalsy()
      expect(catalog.find((m) => m.id === 'claude-fable-5-2')).toMatchObject({
        family: 'fable',
        label: 'Fable 5.2',
        isLatest: true,
        pricing: { inputPerMtok: 8, outputPerMtok: 40, cacheReadPerMtok: 0.2, speedMultipliers: { fast: 2 } },
      })
      expect(await resolveModelForProvider('fable', providerId, 'agent')).toBe('claude-fable-5-2')
    }
  })

  it('offers fast mode on Platform for every Claude id Anthropic serves it on', async () => {
    const catalog = getProviderCatalog('platform')
    for (const id of ['claude-opus-5', 'claude-opus-5-5', 'claude-fable-5-2']) {
      expect(catalog.find((m) => m.id === id)!.supportedSpeeds).toEqual(['normal', 'fast'])
    }
    // Retired fast modes: 4.7's on 2026-07-24, 4.8's on 2026-11-30. Fable 5.1
    // and 5 never had one.
    for (const id of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5', 'claude-fable-5-1']) {
      expect(catalog.find((m) => m.id === id)!.supportedSpeeds).toBeUndefined()
    }
  })

  // Effort lists mirror what each serving path accepted live on 2026-09-18.
  it.each([
    ['claude-haiku-4-5', ['low', 'medium', 'high']],
    ['claude-haiku-5-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-sonnet-4-6', ['low', 'medium', 'high', 'max']],
    ['claude-sonnet-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-sonnet-5-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-6', ['low', 'medium', 'high', 'max']],
    ['claude-opus-4-7', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-fable-5-1', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-fable-5-2', ['low', 'medium', 'high', 'xhigh', 'max']],
  ])('anthropic %s accepts efforts %j', (id, efforts) => {
    const model = getProviderCatalog('anthropic').find((m) => m.id === id)!
    expect(model.supportedEfforts).toEqual(efforts)
  })

  it.each([
    ['gpt-5.6-luna', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.6-terra', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6-luna', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6-sol', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6.1-terra', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['grok-4.7', ['low', 'medium', 'high', 'xhigh']],
    ['grok-4.6', ['low', 'medium', 'high', 'xhigh']],
    ['grok-4.5', ['low', 'medium', 'high']],
    ['gemini-4-argon', ['low', 'medium', 'high']],
    ['muse-wonder-1.0', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['muse-spark-1.3', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['muse-spark-1.2', ['low', 'medium', 'high', 'xhigh']],
    ['muse-spark-1.3-contributor', ['low', 'medium', 'high', 'xhigh']],
    ['kimi-k3', ['low', 'medium', 'high', 'max']],
    ['glm-5.3-flash', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['deepseek-v4.1-flash', ['low', 'medium', 'high']],
  ])('platform %s accepts efforts %j', (id, efforts) => {
    const model = getProviderCatalog('platform').find((m) => m.id === id)!
    expect(model.supportedEfforts).toEqual(efforts)
  })

  it('exposes the OpenRouter non-Claude built-ins (gpt, glm, grok) with their own icons', async () => {
    const catalog = getProviderCatalog('openrouter')
    const gpt = catalog.find((m) => m.id === 'openai/gpt-5.5')!
    const glm = catalog.find((m) => m.id === 'z-ai/glm-5.2')!
    const grok = catalog.find((m) => m.id === 'x-ai/grok-4.7')!
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
      pricing: {
        inputPerMtok: 1.2,
        outputPerMtok: 4.2,
        cacheCreationPerMtok: 0,
        cacheCreation1hPerMtok: 0,
      },
    })
    expect(grok).toMatchObject({
      family: 'grok',
      isLatest: true,
      icon: 'xai',
      supportsWebSearch: false,
      pricing: { inputPerMtok: 2, outputPerMtok: 6 },
      contextWindow: 500_000,
    })
    expect(catalog.find((m) => m.id === 'x-ai/grok-4.5')).toMatchObject({
      family: 'grok',
      icon: 'xai',
      supportsWebSearch: false,
      pricing: { inputPerMtok: 2, outputPerMtok: 6 },
      contextWindow: 500_000,
    })
    expect(catalog.find((m) => m.id === 'x-ai/grok-4.6')).toMatchObject({
      family: 'grok',
      icon: 'xai',
      supportsWebSearch: false,
      pricing: { inputPerMtok: 2, outputPerMtok: 6 },
      contextWindow: 500_000,
    })
    expect(catalog.find((m) => m.id === 'x-ai/grok-4.6')!.isLatest).toBeFalsy()
    expect(catalog.find((m) => m.id === 'x-ai/grok-4.5')!.isLatest).toBeFalsy()
    // Anthropic must NOT inherit the OpenRouter-only extras.
    expect(getProviderCatalog('anthropic').some((m) => m.id === 'openai/gpt-5.5')).toBe(false)
    expect(getProviderCatalog('anthropic').some((m) => m.id === 'x-ai/grok-4.5')).toBe(false)
    expect(getProviderCatalog('platform').some((m) => m.id === 'x-ai/grok-4.5')).toBe(false)
  })

  it('offers the Kimi line on OpenRouter, K3 latest with the cheaper K2 versions pinnable', async () => {
    const catalog = getProviderCatalog('openrouter')
    expect(catalog.find((m) => m.id === 'moonshotai/kimi-k3')).toMatchObject({
      family: 'kimi',
      isLatest: true,
      icon: 'kimi',
      supportsWebSearch: false,
      pricing: { inputPerMtok: 3, outputPerMtok: 15 },
      contextWindow: 1_048_576,
    })
    expect(catalog.find((m) => m.id === 'moonshotai/kimi-k2.7-code')).toMatchObject({
      family: 'kimi',
      icon: 'kimi',
      pricing: { inputPerMtok: 0.73, outputPerMtok: 3.5 },
      contextWindow: 262_144,
    })
    expect(catalog.find((m) => m.id === 'moonshotai/kimi-k2.6')).toMatchObject({
      family: 'kimi',
      icon: 'kimi',
      pricing: { inputPerMtok: 0.646, outputPerMtok: 2.72 },
      contextWindow: 262_144,
    })
    // Exactly one latest, or the bare `kimi` alias is ambiguous.
    const kimiLatest = catalog.filter((m) => m.family === 'kimi' && m.isLatest)
    expect(kimiLatest.map((m) => m.id)).toEqual(['moonshotai/kimi-k3'])
    // OpenRouter ignores our speed header, so no entry may claim a speed knob.
    for (const m of catalog.filter((m) => m.family === 'kimi')) {
      expect(m.supportedSpeeds).toBeUndefined()
    }
    // The two catalogs keep their own ids — no cross-contamination.
    expect(catalog.some((m) => m.id === 'kimi-k3')).toBe(false)
    expect(getProviderCatalog('platform').some((m) => m.id === 'moonshotai/kimi-k3')).toBe(false)
    expect(getProviderCatalog('anthropic').some((m) => m.family === 'kimi')).toBe(false)
  })

  it('offers both GPT versions, with 5.5 the family latest and 5.4 a pinnable older version', async () => {
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

  it('exposes the Platform GPT built-ins under BARE ids the proxy routes', async () => {
    const catalog = getProviderCatalog('platform')
    // gpt rides the OpenAI Responses wire, which maps native web_search.
    expect(catalog.some((m) => m.id === 'gpt-5.4' || m.id === 'gpt-5.5')).toBe(false)
    expect(catalog.find((m) => m.id === 'gpt-5.6-luna')).toMatchObject({
      family: 'gpt-luna',
      icon: 'openai',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 1, outputPerMtok: 6 },
    })
    expect(catalog.find((m) => m.id === 'gpt-5.6-terra')).toMatchObject({
      family: 'gpt-terra',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 2.5, outputPerMtok: 15 },
    })
    expect(catalog.find((m) => m.id === 'gpt-5.6-sol')).toMatchObject({
      family: 'gpt-sol',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 5, outputPerMtok: 30 },
    })
    expect(catalog.find((m) => m.id === 'gpt-6-luna')).toMatchObject({
      family: 'gpt-luna',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 0.1, outputPerMtok: 0.5 },
      contextWindow: 1_050_000,
    })
    expect(catalog.find((m) => m.id === 'gpt-6-sol')).toMatchObject({
      family: 'gpt-sol',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 2, outputPerMtok: 10 },
      contextWindow: 1_050_000,
    })
    // 6.1 Sol matches 6 Sol's $2/$10, with cache reads at 5% instead of 10%.
    expect(catalog.find((m) => m.id === 'gpt-6.1-sol')).toMatchObject({
      family: 'gpt-sol',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 2, outputPerMtok: 10, cacheReadPerMtok: 0.1 },
      contextWindow: 1_050_000,
    })
    expect(catalog.find((m) => m.id === 'gpt-6.1-terra')).toMatchObject({
      family: 'gpt-terra',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 1, outputPerMtok: 5, cacheReadPerMtok: 0.05 },
      contextWindow: 1_050_000,
    })
    expect(catalog.find((m) => m.id === 'gpt-6-astra')).toMatchObject({
      family: 'gpt-astra',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 10, outputPerMtok: 50 },
      contextWindow: 1_050_000,
    })
    // Each OpenAI tier is its own family, so each bare alias rides its own tier.
    const gptLatest = catalog.filter((m) => m.family?.startsWith('gpt-') && m.isLatest)
    expect(gptLatest.map((m) => [m.family, m.id])).toEqual([
      ['gpt-luna', 'gpt-6-luna'],
      ['gpt-terra', 'gpt-6.1-terra'],
      ['gpt-sol', 'gpt-6.1-sol'],
      ['gpt-astra', 'gpt-6-astra'],
    ])
    // Grok rides the same Responses wire (xai-responses upstream); bare id only.
    expect(catalog.find((m) => m.id === 'grok-4.7')).toMatchObject({
      family: 'grok',
      isLatest: true,
      icon: 'xai',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 2, outputPerMtok: 6 },
      contextWindow: 500_000,
    })
    expect(catalog.find((m) => m.id === 'grok-4.6')).toMatchObject({
      family: 'grok',
      icon: 'xai',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 2, outputPerMtok: 6 },
      contextWindow: 500_000,
    })
    expect(catalog.find((m) => m.id === 'grok-4.6')!.isLatest).toBeFalsy()
    expect(catalog.find((m) => m.id === 'grok-4.5')).toMatchObject({
      family: 'grok',
      icon: 'xai',
      supportsWebSearch: true,
      supportsWebFetch: false,
      pricing: { inputPerMtok: 2, outputPerMtok: 6 },
      contextWindow: 500_000,
    })
    expect(catalog.find((m) => m.id === 'grok-4.5')!.isLatest).toBeFalsy()
    const grokLatest = catalog.filter((m) => m.family === 'grok' && m.isLatest)
    expect(grokLatest.map((m) => m.id)).toEqual(['grok-4.7'])
    // Kimi rides Fireworks' Anthropic-compatible wire, which strips server tools.
    expect(catalog.find((m) => m.id === 'kimi-k3')).toMatchObject({
      family: 'kimi',
      isLatest: true,
      icon: 'kimi',
      supportsWebSearch: false,
      supportsWebFetch: false,
      supportedSpeeds: ['normal', 'fast'],
      pricing: { inputPerMtok: 3, outputPerMtok: 15, speedMultipliers: { fast: 1.5 } },
    })
    // Cloudflare Workers AI via the platform proxy. Bare id only.
    expect(catalog.find((m) => m.id === 'glm-5.3-flash')).toMatchObject({
      family: 'glm',
      isLatest: true,
      icon: 'zai',
      supportsWebSearch: false,
      supportsWebFetch: false,
      supportsImageInput: true,
      contextWindow: 1_048_576,
      pricing: { inputPerMtok: 0.15, outputPerMtok: 0.5, cacheReadPerMtok: 0.03 },
    })
    expect(catalog.find((m) => m.id === 'glm-5.3')).toMatchObject({
      label: 'GLM-5.3 Standard',
      family: 'glm',
      icon: 'zai',
      supportedEfforts: ['low', 'medium', 'high'],
      supportsWebSearch: false,
      supportsWebFetch: false,
      supportsImageInput: false,
      contextWindow: 1_048_576,
      pricing: { inputPerMtok: 1.4, outputPerMtok: 4.4, cacheReadPerMtok: 0.26 },
    })
    expect(catalog.find((m) => m.id === 'glm-5.3')!.supportedSpeeds).toBeUndefined()
    expect(catalog.find((m) => m.id === 'glm-5.3')!.isLatest).toBeFalsy()
    expect(catalog.find((m) => m.id === 'glm-5.3')!.isDefault).toBeFalsy()
    // DeepSeek rides Fireworks' Anthropic-compatible wire; no fast router, so no speeds.
    expect(catalog.find((m) => m.id === 'deepseek-v4.1-flash')).toMatchObject({
      family: 'deepseek',
      isLatest: true,
      icon: 'deepseek',
      supportsWebSearch: false,
      supportsWebFetch: false,
      supportsImageInput: true,
      contextWindow: 1_040_000,
      pricing: { inputPerMtok: 0.3, outputPerMtok: 1.2, cacheReadPerMtok: 0.006 },
    })
    expect(catalog.find((m) => m.id === 'deepseek-v4.1-flash')!.supportedSpeeds).toBeUndefined()
    // Platform keys off bare ids, never the OpenRouter vendor-prefixed slugs.
    expect(catalog.some((m) => m.id === 'openai/gpt-5.5')).toBe(false)
    expect(catalog.some((m) => m.id === 'z-ai/glm-5.2')).toBe(false)
    expect(catalog.some((m) => m.id === 'glm-5.2')).toBe(false)
    expect(catalog.some((m) => m.id === 'x-ai/grok-4.5')).toBe(false)
    expect(catalog.some((m) => m.id === 'x-ai/grok-4.6')).toBe(false)
    expect(catalog.some((m) => m.id === 'x-ai/grok-4.7')).toBe(false)
  })
})

describe('getEffectiveCatalog', () => {
  it('returns the built-in catalog unchanged when no overrides are configured', async () => {
    expect(await getEffectiveCatalog('anthropic')).toEqual(getProviderCatalog('anthropic'))
  })

  it('disables built-ins and treats unknown disables as a no-op', async () => {
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

    const catalog = await getEffectiveCatalog('anthropic')
    expect(catalog.some((model) => model.id === 'claude-haiku-4-5')).toBe(false)
    expect(catalog.some((model) => model.id === 'missing-model')).toBe(false)
  })

  it('patches built-ins while preserving sibling fields', async () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelPricing: { 'claude-opus-4-8': { inputPerMtok: 7, outputPerMtok: 31 } },
      modelCatalog: {
        anthropic: {
          overrides: [
            {
              id: 'claude-opus-4-8',
              label: 'Opus patched',
              blurb: 'Fresh label',
            },
          ],
        },
      },
    })

    const opus = (await getEffectiveCatalog('anthropic')).find((model) => model.id === 'claude-opus-4-8')!
    expect(opus).toMatchObject({
      label: 'Opus patched',
      blurb: 'Fresh label',
      family: 'opus',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      pricing: { inputPerMtok: 7, outputPerMtok: 31 },
    })
  })

  it('uses global pricing overrides instead of provider catalog prices', async () => {
    settingsMock.mockReturnValue({
      llmProvider: 'openrouter',
      modelPricing: { 'glm-5.2': { inputPerMtok: 2, outputPerMtok: 6 } },
      modelCatalog: { openrouter: { overrides: [{ id: 'z-ai/glm-5.2', pricing: { inputPerMtok: 99, outputPerMtok: 99 } }] } },
    })
    // Input/output come from the global override; the cache rates it leaves
    // unset keep the built-in card's ratios (free writes, reads at 10% of
    // input), which is what usage accounting bills.
    const pricing = (await getEffectiveCatalog('openrouter')).find(model => model.id === 'z-ai/glm-5.2')?.pricing
    expect(pricing).toMatchObject({
      inputPerMtok: 2,
      outputPerMtok: 6,
      cacheCreationPerMtok: 0,
      cacheCreation1hPerMtok: 0,
    })
    expect(pricing?.cacheReadPerMtok).toBeCloseTo(0.2, 9)
  })

  it('appends valid net-new models after built-ins', async () => {
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

    const catalog = await getEffectiveCatalog('anthropic')
    expect(catalog[catalog.length - 1]?.id).toBe('claude-opus-4-9-custom')
  })

  it('removes disabled custom models from the effective selectable catalog', async () => {
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

    expect((await getEffectiveCatalog('anthropic')).some((model) => model.id === 'claude-opus-4-9-custom')).toBe(false)
  })

  it('keeps one entry for same-id patches and lets duplicate overrides resolve last-wins', async () => {
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

    const catalog = await getEffectiveCatalog('anthropic')
    expect(catalog.filter((model) => model.id === 'claude-opus-4-8')).toHaveLength(1)
    expect(catalog.find((model) => model.id === 'claude-opus-4-8')?.label).toBe('Last label')
  })

  it('lets disabled win when a single override also contains patch fields', async () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [{ id: 'claude-opus-4-8', disabled: true, label: 'Hidden Opus' }],
        },
      },
    })

    expect((await getEffectiveCatalog('anthropic')).some((model) => model.id === 'claude-opus-4-8')).toBe(false)
  })

  it('drops and warns for structurally invalid effective entries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [
            { id: 'incomplete-custom' },
            {
              id: 'claude-opus-4-8',
              pricing: { inputPerMtok: -1, outputPerMtok: 25 },
            },
          ],
        },
      },
    })

    const catalog = await getEffectiveCatalog('anthropic')
    expect(catalog.some((model) => model.id === 'incomplete-custom')).toBe(false)
    expect(catalog.some((model) => model.id === 'claude-opus-4-8')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('normalizes family latest flags after custom and family patches', async () => {
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

    const catalog = await getEffectiveCatalog('anthropic')
    expect(catalog.filter((model) => model.family === 'opus' && model.isLatest).map((model) => model.id))
      .toEqual(['claude-opus-4-9-custom'])
  })

  it('keeps provider overrides isolated even for shared Claude catalog entries', async () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: { overrides: [{ id: 'claude-opus-4-8', disabled: true }] },
      },
    })

    expect((await getEffectiveCatalog('anthropic')).some((model) => model.id === 'claude-opus-4-8')).toBe(false)
    expect((await getEffectiveCatalog('openrouter')).some((model) => model.id === 'claude-opus-4-8')).toBe(true)
  })
})

describe('getModelContextWindow', () => {
  it('returns the catalog window for Platform GPT models', async () => {
    expect(await getModelContextWindow('gpt-5.6-sol', 'platform')).toBe(1_050_000)
    expect(await getModelContextWindow('gpt-6-sol', 'platform')).toBe(1_050_000)
    expect(await getModelContextWindow('gpt-6.1-sol', 'platform')).toBe(1_050_000)
    expect(await getModelContextWindow('gpt-6.1-terra', 'platform')).toBe(1_050_000)
    expect(await getModelContextWindow('gpt-6-luna', 'platform')).toBe(1_050_000)
  })

  it('returns the catalog window for Platform Grok models', async () => {
    expect(await getModelContextWindow('grok-4.7', 'platform')).toBe(500_000)
    expect(await getModelContextWindow('grok-4.6', 'platform')).toBe(500_000)
    expect(await getModelContextWindow('grok-4.5', 'platform')).toBe(500_000)
  })

  it('returns the catalog window for OpenRouter GPT models', async () => {
    expect(await getModelContextWindow('openai/gpt-5.5', 'openrouter')).toBe(1_050_000)
    expect(await getModelContextWindow('z-ai/glm-5.2', 'openrouter')).toBeUndefined()
  })

  it('returns undefined for Claude models (SDK supplies their window)', async () => {
    expect(await getModelContextWindow('claude-opus-4-8', 'anthropic')).toBeUndefined()
  })

  it('returns undefined for an unknown id', async () => {
    expect(await getModelContextWindow('nope', 'platform')).toBeUndefined()
  })
})

describe('getModelContextWindowMap', () => {
  it('maps every Platform model that declares a window, non-latest included', async () => {
    const map = getModelContextWindowMap(await getEffectiveCatalog('platform'))
    expect(map['grok-4.7']).toBe(500_000)
    expect(map['grok-4.6']).toBe(500_000)
    expect(map['grok-4.5']).toBe(500_000)
    expect(map['gpt-5.6-sol']).toBe(1_050_000)
    expect(map['gpt-6-sol']).toBe(1_050_000)
  })

  it('omits Claude models (no catalog window; the SDK supplies theirs)', async () => {
    const map = getModelContextWindowMap(await getEffectiveCatalog('platform'))
    expect(Object.keys(map).some(id => id.startsWith('claude-'))).toBe(false)
  })
})

describe('getModelPromptHints', () => {
  it('returns GPT-specific tool guidance for Platform and OpenRouter GPT models', async () => {
    for (const [providerId, modelId] of [
      ['platform', 'gpt-5.6-sol'],
      ['openrouter', 'openai/gpt-5.5'],
    ] as const) {
      const hints = await getModelPromptHints(modelId, providerId)
      expect(hints.some((hint) => hint.includes('ToolSearch'))).toBe(true)
      expect(hints.some((hint) => hint.includes('pages as an empty string'))).toBe(true)
    }
  })

  it('returns browser-integration guidance for Platform and OpenRouter Grok models', async () => {
    for (const [providerId, modelId] of [
      ['platform', 'grok-4.7'],
      ['platform', 'grok-4.6'],
      ['platform', 'grok-4.5'],
      ['openrouter', 'x-ai/grok-4.7'],
      ['openrouter', 'x-ai/grok-4.6'],
      ['openrouter', 'x-ai/grok-4.5'],
    ] as const) {
      const hints = await getModelPromptHints(modelId, providerId)
      expect(hints.some((hint) => hint.includes('mcp__browser__browser_*'))).toBe(true)
      expect(hints.some((hint) => hint.includes('exact full names'))).toBe(true)
      expect(hints.some((hint) => hint.includes('agent-browser'))).toBe(true)
    }
  })

  it('returns an empty list for Claude models and unknown ids', async () => {
    expect(await getModelPromptHints('claude-opus-4-8', 'anthropic')).toEqual([])
    expect(await getModelPromptHints('nope', 'platform')).toEqual([])
  })
})

describe('hasVersionSegment', () => {
  it('detects a hyphen-digit version segment', async () => {
    expect(hasVersionSegment('claude-opus-4-8')).toBe(true)
    expect(hasVersionSegment('us.anthropic.claude-opus-4-8')).toBe(true)
    expect(hasVersionSegment('gpt-4o')).toBe(true)
  })
  it('returns false for bare family aliases', async () => {
    expect(hasVersionSegment('opus')).toBe(false)
    expect(hasVersionSegment('sonnet')).toBe(false)
  })
})

describe('getModelDefinition', () => {
  it('looks up a concrete id', async () => {
    expect((await getModelDefinition('claude-opus-4-7', 'anthropic'))?.label).toBe('Opus 4.7')
  })
  it('returns undefined for an unknown id', async () => {
    expect(await getModelDefinition('nope', 'anthropic')).toBeUndefined()
  })
})

describe('resolveModelForProvider', () => {
  it('passes an exact catalog id straight through (pin)', async () => {
    expect(await resolveModelForProvider('claude-opus-4-7', 'anthropic', 'agent')).toBe('claude-opus-4-7')
  })

  it('resolves the default haiku summarizer to Haiku 5.5 on every Claude-catalog provider', async () => {
    for (const provider of ['anthropic', 'claude-subscription', 'platform'] as const) {
      expect(await resolveModelForProvider('haiku', provider, 'summarizer')).toBe('claude-haiku-5-5')
    }
  })

  it('defaults the browser model to Haiku 5.5 on every Claude-catalog provider', async () => {
    for (const provider of ['anthropic', 'claude-subscription', 'openrouter', 'platform'] as const) {
      expect(await resolveModelForProvider('mystery', provider, 'browser')).toBe('claude-haiku-5-5')
    }
  })

  it('resolves a bare family alias to that family latest id', async () => {
    expect(await resolveModelForProvider('opus', 'anthropic', 'agent')).toBe('claude-opus-5-5')
    expect(await resolveModelForProvider('sonnet', 'anthropic', 'agent')).toBe('claude-sonnet-5-5')
  })

  it('keeps an explicit Opus 5 pin on Opus 5 after 5.5 becomes latest', async () => {
    for (const providerId of ['anthropic', 'openrouter', 'platform'] as const) {
      expect(await resolveModelForProvider('claude-opus-5', providerId, 'agent')).toBe('claude-opus-5')
      expect(await resolveModelForProvider('claude-opus-5-5', providerId, 'agent')).toBe('claude-opus-5-5')
    }
  })

  it('passes an unknown but versioned id straight through (treated as a pin)', async () => {
    expect(await resolveModelForProvider('claude-opus-9-9', 'anthropic', 'agent')).toBe('claude-opus-9-9')
  })

  it('falls back to the provider default (alias-resolved) for an unknown family-less alias', async () => {
    // Anthropic agent default is 'opus' → resolves to its latest concrete id.
    expect(await resolveModelForProvider('mystery', 'anthropic', 'agent')).toBe('claude-opus-5-5')
    // Summarizer default 'haiku' → latest haiku.
    expect(await resolveModelForProvider('mystery', 'anthropic', 'summarizer')).toBe('claude-haiku-5-5')
  })

  it('resolves OpenRouter non-Claude models (gpt alias → latest id, glm slug passthrough)', async () => {
    expect(await resolveModelForProvider('gpt', 'openrouter', 'agent')).toBe('openai/gpt-5.5')
    expect(await resolveModelForProvider('z-ai/glm-5.2', 'openrouter', 'agent')).toBe('z-ai/glm-5.2')
    expect(await resolveModelForProvider('grok', 'openrouter', 'agent')).toBe('x-ai/grok-4.7')
    expect(await resolveModelForProvider('x-ai/grok-4.7', 'openrouter', 'agent')).toBe('x-ai/grok-4.7')
    expect(await resolveModelForProvider('x-ai/grok-4.6', 'openrouter', 'agent')).toBe('x-ai/grok-4.6')
    expect(await resolveModelForProvider('x-ai/grok-4.5', 'openrouter', 'agent')).toBe('x-ai/grok-4.5')
  })

  it('resolves the kimi alias per provider, since the two catalogs use different ids', async () => {
    expect(await resolveModelForProvider('kimi', 'openrouter', 'agent')).toBe('moonshotai/kimi-k3')
    expect(await resolveModelForProvider('kimi', 'platform', 'agent')).toBe('kimi-k3')
    // Pinning an older version stays pinned rather than riding the alias.
    expect(await resolveModelForProvider('moonshotai/kimi-k2.6', 'openrouter', 'agent')).toBe(
      'moonshotai/kimi-k2.6',
    )
  })

  it('resolves Platform GPT/Grok/GLM/DeepSeek models to bare ids', async () => {
    expect(await resolveModelForProvider('deepseek', 'platform', 'agent')).toBe('deepseek-v4.1-flash')
    expect(await resolveModelForProvider('deepseek-v4.1-flash', 'platform', 'agent')).toBe(
      'deepseek-v4.1-flash',
    )
    expect(await resolveModelForProvider('gpt', 'platform', 'agent')).toBe('gpt-6.1-sol')
    expect(await resolveModelForProvider('gpt-sol', 'platform', 'agent')).toBe('gpt-6.1-sol')
    // Removed from the catalog, but a stored pin still passes through to the proxy.
    expect(await resolveModelForProvider('gpt-5.4', 'platform', 'agent')).toBe('gpt-5.4')
    expect(await resolveModelForProvider('gpt-5.6-luna', 'platform', 'agent')).toBe('gpt-5.6-luna')
    expect(await resolveModelForProvider('grok', 'platform', 'agent')).toBe('grok-4.7')
    expect(await resolveModelForProvider('grok-4.7', 'platform', 'agent')).toBe('grok-4.7')
    expect(await resolveModelForProvider('grok-4.6', 'platform', 'agent')).toBe('grok-4.6')
    expect(await resolveModelForProvider('grok-4.5', 'platform', 'agent')).toBe('grok-4.5')
    expect(await resolveModelForProvider('glm', 'platform', 'agent')).toBe('glm-5.3-flash')
    expect(await resolveModelForProvider('glm-5.3-flash', 'platform', 'agent')).toBe('glm-5.3-flash')
  })

  it('resolves the SAME bare alias to each provider concrete id (cross-provider portability)', async () => {
    expect(await resolveModelForProvider('opus', 'anthropic', 'agent')).toBe('claude-opus-5-5')
    // Bedrock's opus family stays on 4.8 until AWS publishes an Opus 5 region id.
    expect(await resolveModelForProvider('opus', 'bedrock', 'agent')).toBe('us.anthropic.claude-opus-4-8')
  })

  it('falls back to the Bedrock default (concrete region id) for an Anthropic-only pin', async () => {
    // An Anthropic pin that does not exist in Bedrock's catalog AND has no
    // version segment would hit the default; but a versioned unknown passes
    // through. Use a bare unknown alias to exercise the default path.
    expect(await resolveModelForProvider('unknown-alias', 'bedrock', 'agent')).toBe('us.anthropic.claude-sonnet-5')
  })

  it('resolves custom model ids and custom latest aliases through the effective catalog', async () => {
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

    expect(await resolveModelForProvider('claude-opus-4-9-custom', 'anthropic', 'agent')).toBe('claude-opus-4-9-custom')
    expect(await resolveModelForProvider('opus', 'anthropic', 'agent')).toBe('claude-opus-4-9-custom')
  })

  it('handles the generic provider empty built-in catalog: resolves user-added ids, passes versioned pins, else falls back to the default', async () => {
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
    expect(await resolveModelForProvider('llama3.1', 'generic', 'agent')).toBe('llama3.1')
    // 2. An unknown but versioned selection passes straight through to the SDK.
    expect(await resolveModelForProvider('mixtral-8x7b', 'generic', 'agent')).toBe('mixtral-8x7b')
    // 3. An unknown alias falls back to the default — the first user-added model.
    expect(await resolveModelForProvider('mystery', 'generic', 'agent')).toBe('llama3.1')
  })

  it('falls back to the generic placeholder default when no user models are configured', async () => {
    settingsMock.mockReturnValue({ llmProvider: 'generic' })
    expect(await resolveModelForProvider('mystery', 'generic', 'agent')).toBe('default')
  })

  it('falls back cleanly when the only latest member of a family is disabled', async () => {
    settingsMock.mockReturnValue({
      llmProvider: 'anthropic',
      modelCatalog: {
        anthropic: {
          overrides: [{ id: 'claude-haiku-5-5', disabled: true }],
        },
      },
    })

    expect(await resolveModelForProvider('haiku', 'anthropic', 'summarizer')).toBe('haiku')
  })
})

describe('resolveActiveProviderModel', () => {
  it('resolves against the active provider from settings', async () => {
    settingsMock.mockReturnValue({ llmProvider: 'bedrock' })
    expect(await resolveActiveProviderModel('opus', 'agent')).toBe('us.anthropic.claude-opus-4-8')
  })
})
