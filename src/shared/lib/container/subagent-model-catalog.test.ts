import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingsMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: () => settingsMock(),
  getModelCatalogSettings: () => settingsMock().modelCatalog ?? {},
}))

import { getEffectiveCatalog, resolveModelForProvider } from '../llm-provider'
import {
  getSubagentModelCatalog,
  MAX_SUBAGENT_MODELS,
  subagentModelCatalogSchema,
} from './subagent-model-catalog'

beforeEach(() => {
  settingsMock.mockReturnValue({ llmProvider: 'openrouter' })
})

describe('getSubagentModelCatalog', () => {
  it('projects only latest models from the active provider in deterministic order', async () => {
    const effective = await getEffectiveCatalog('openrouter')
    const catalog = getSubagentModelCatalog(await getEffectiveCatalog('openrouter'))

    expect(catalog.map((model) => model.id)).toEqual(
      effective
        .filter((model) => model.isLatest === true)
        .slice(0, MAX_SUBAGENT_MODELS)
        .map((model) => model.id),
    )
    expect(catalog.every((model) => model.isLatest === true)).toBe(true)
    expect(catalog.length).toBeLessThanOrEqual(MAX_SUBAGENT_MODELS)
    expect(subagentModelCatalogSchema.parse(catalog)).toEqual(catalog)
  })

  it('does not create separate subagents for older versions in a model family', async () => {
    const effective = await getEffectiveCatalog('anthropic')
    const catalog = getSubagentModelCatalog(await getEffectiveCatalog('anthropic'))

    expect(effective.some((model) => model.id === 'claude-opus-4-8')).toBe(true)
    expect(effective.some((model) => model.id === 'claude-opus-5')).toBe(true)
    expect(catalog.some((model) => model.id === 'claude-opus-4-8')).toBe(false)
    expect(catalog.some((model) => model.id === 'claude-opus-5')).toBe(false)
    expect(catalog.some((model) => model.id === 'claude-opus-5-5')).toBe(true)
  })

  it('exposes the latest model of each GPT tier family as a subagent', async () => {
    settingsMock.mockReturnValue({ llmProvider: 'platform' })
    const gptIds = async (provider: 'platform' | 'codex-subscription') =>
      getSubagentModelCatalog(await getEffectiveCatalog(provider))
        .map((model) => model.id)
        .filter((id) => id.startsWith('gpt-'))

    const latestPerTier = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra']
    expect((await gptIds('platform')).sort()).toEqual([...latestPerTier].sort())
    expect((await gptIds('codex-subscription')).sort()).toEqual([...latestPerTier].sort())
    expect(await resolveModelForProvider('gpt-sol', 'platform', 'agent')).toBe('gpt-6.1-sol')
    expect(await resolveModelForProvider('gpt-astra', 'platform', 'agent')).toBe('gpt-6-astra')
  })

  it('keeps a stored bare gpt selection on the Sol family', async () => {
    settingsMock.mockReturnValue({ llmProvider: 'platform' })

    expect(await resolveModelForProvider('gpt', 'platform', 'agent')).toBe('gpt-6.1-sol')
    expect(await resolveModelForProvider('gpt', 'codex-subscription', 'agent')).toBe('gpt-6.1-sol')
  })

  it('does not pass disabled catalog entries to the container', async () => {
    settingsMock.mockReturnValue({
      llmProvider: 'openrouter',
      modelCatalog: {
        openrouter: {
          overrides: [{ id: 'openai/gpt-5.5', disabled: true }],
        },
      },
    })

    expect(getSubagentModelCatalog(await getEffectiveCatalog('openrouter')).some((model) => model.id === 'openai/gpt-5.5')).toBe(false)
  })

  it('warns when the effective catalog exceeds the subagent cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    settingsMock.mockReturnValue({
      llmProvider: 'openrouter',
      modelCatalog: {
        openrouter: {
          overrides: Array.from({ length: MAX_SUBAGENT_MODELS + 1 }, (_, index) => ({
            id: `custom/model-${index}`,
            label: `Custom ${index}`,
            family: `custom-${index}`,
            isLatest: true,
            supportedEfforts: ['low', 'medium', 'high'],
          })),
        },
      },
    })

    expect(getSubagentModelCatalog(await getEffectiveCatalog('openrouter'))).toHaveLength(MAX_SUBAGENT_MODELS)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('only the first 32'))
    warn.mockRestore()
  })
})
