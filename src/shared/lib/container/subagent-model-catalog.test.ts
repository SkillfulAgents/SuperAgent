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
  it('projects the active provider effective catalog in deterministic order', () => {
    const effective = getEffectiveCatalog('openrouter')
    const catalog = getSubagentModelCatalog('openrouter')

    expect(catalog.map((model) => model.id)).toEqual(
      effective.slice(0, MAX_SUBAGENT_MODELS).map((model) => model.id),
    )
    expect(catalog.length).toBeLessThanOrEqual(MAX_SUBAGENT_MODELS)
    expect(subagentModelCatalogSchema.parse(catalog)).toEqual(catalog)
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
})
