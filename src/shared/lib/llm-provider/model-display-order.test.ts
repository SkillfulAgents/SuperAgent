import { describe, expect, it } from 'vitest'
import { BEDROCK_CATALOG, CLAUDE_BARE_CATALOG, OPENROUTER_CATALOG, PLATFORM_CATALOG } from './builtin-catalogs'
import { compareModelDisplayOrder, compareModelTier, modelDisplayOrder } from './model-display-order'
import type { ModelDefinition } from './model-catalog-schema'

const model = (id: string): ModelDefinition => ({ id, label: id, supportedEfforts: ['high'] })
const ordered = (ids: string[]) => ids.map(model).sort(compareModelDisplayOrder).map((m) => m.id)

describe('model display order', () => {
  it('covers every built-in model and subscription-only model id', () => {
    for (const entry of [...CLAUDE_BARE_CATALOG, ...BEDROCK_CATALOG, ...OPENROUTER_CATALOG, ...PLATFORM_CATALOG]) {
      expect(modelDisplayOrder(entry.id), entry.id).toBeDefined()
    }
    for (const id of ['k3-256k', 'grok-4.7-build', 'MiniMax-M3', 'glm-5.3']) {
      expect(modelDisplayOrder(id), id).toBeDefined()
    }
  })

  it.each([
    ['gpt-5.4', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-sol'],
    ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    ['grok-4.5', 'grok-4.6', 'grok-4.7'],
    ['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3'],
    ['muse-spark-1.1', 'muse-spark-1.2-contributor', 'muse-spark-1.2', 'muse-spark-1.3-contributor', 'muse-spark-1.3'],
    ['glm-5.2', 'glm-5.3-flash', 'glm-5.3'],
  ].map((ids) => [ids]))('sorts the complete vendor lineup %j by generation then variant', (ids) => {
    expect(ordered(ids)).toEqual([...ids].reverse())
  })

  it('shares display metadata across provider namespaces and dated ids', () => {
    expect(modelDisplayOrder('openai/gpt-6.1-sol')).toEqual(modelDisplayOrder('gpt-6.1-sol'))
    expect(modelDisplayOrder('us.anthropic.claude-opus-4-6-v1')).toEqual(modelDisplayOrder('claude-opus-4-6'))
    expect(modelDisplayOrder('anthropic/claude-sonnet-4.6')).toEqual(modelDisplayOrder('claude-sonnet-4-6'))
    expect(modelDisplayOrder('k3-256k')).toEqual(modelDisplayOrder('kimi-k3'))
    expect(modelDisplayOrder('private/gpt-6.1-sol')).toBeUndefined()
  })

  it('does not use labels, pricing, latest flags or defaults to rank models', () => {
    const older = { ...model('gpt-6-astra'), label: 'GPT-100', isLatest: true, isDefault: true, pricing: { inputPerMtok: 100, outputPerMtok: 1000 } }
    const newer = model('gpt-6.1-sol')
    expect([older, newer].sort(compareModelDisplayOrder)).toEqual([newer, older])
    expect(modelDisplayOrder('gpt-6-astra')?.releaseGroup).toBe('GPT-6')
  })

  it('keeps unknown custom models in stable catalog order after curated entries', () => {
    expect(ordered(['custom-2', 'gpt-6.1-sol', 'custom-1'])).toEqual(['gpt-6.1-sol', 'custom-2', 'custom-1'])
  })

  it('orders tiers strongest-first and keeps unknown tiers after them in input order', () => {
    expect(['haiku', 'sonnet', 'fable', 'opus'].sort(compareModelTier)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(['Luna', 'Mini', 'Sol', 'Astra', 'Terra', 'Nano'].sort(compareModelTier)).toEqual(['Astra', 'Sol', 'Terra', 'Luna', 'Mini', 'Nano'])
  })
})
