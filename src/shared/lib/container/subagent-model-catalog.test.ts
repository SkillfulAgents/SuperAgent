import { beforeEach, describe, expect, it, vi } from 'vitest'

const settingsMock = vi.fn()
vi.mock('../config/settings', () => ({
  getSettings: () => settingsMock(),
  getModelCatalogSettings: () => settingsMock().modelCatalog ?? {},
}))

import { getEffectiveCatalog } from '../llm-provider'
import {
  getSubagentModelCatalog,
  MAX_SUBAGENT_MODELS,
  subagentModelCatalogSchema,
} from './subagent-model-catalog'

beforeEach(() => {
  settingsMock.mockReturnValue({ llmProvider: 'openrouter' })
})

describe('getSubagentModelCatalog', () => {
  it('projects only latest models from the active provider in deterministic order', () => {
    const effective = getEffectiveCatalog('openrouter')
    const catalog = getSubagentModelCatalog('openrouter')

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

  it('does not create separate subagents for older versions in a model family', () => {
    const effective = getEffectiveCatalog('anthropic')
    const catalog = getSubagentModelCatalog('anthropic')

    expect(effective.some((model) => model.id === 'claude-opus-4-8')).toBe(true)
    expect(catalog.some((model) => model.id === 'claude-opus-4-8')).toBe(false)
    expect(catalog.some((model) => model.id === 'claude-opus-5')).toBe(true)
  })

  it('does not pass disabled catalog entries to the container', () => {
    settingsMock.mockReturnValue({
      llmProvider: 'openrouter',
      modelCatalog: {
        openrouter: {
          overrides: [{ id: 'openai/gpt-5.5', disabled: true }],
        },
      },
    })

    expect(getSubagentModelCatalog('openrouter').some((model) => model.id === 'openai/gpt-5.5')).toBe(false)
  })

  it('warns when the effective catalog exceeds the subagent cap', () => {
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

    expect(getSubagentModelCatalog('openrouter')).toHaveLength(MAX_SUBAGENT_MODELS)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('only the first 32'))
    warn.mockRestore()
  })
})
