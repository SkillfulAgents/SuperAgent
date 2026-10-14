import { describe, expect, it } from 'vitest'

import { PLATFORM_CATALOG } from './builtin-catalogs'
import {
  canonicalModelId,
  excludedModelsLabel,
  isDeniedByPlan,
  normalizeDeniedModels,
  parseModelNotInPlan,
  planDeniedPrefix,
  planModelLabel,
} from './plan-model-policy'
import { bestAllowedModel } from './model-availability'

// Pro 30's list as the proxy test has it; the app must never hard-code it.
const PRO30 = ['claude-fable-', 'gpt-6-astra']
const familyName = (family: string) =>
  ({ fable: 'Fable', 'gpt-astra': 'GPT Astra', opus: 'Opus' } as Record<string, string>)[family] ?? family

describe('planDeniedPrefix — the proxy\'s rule, mirrored', () => {
  it.each([
    ['claude-fable-5-1', 'claude-fable-'],
    ['claude-fable-5', 'claude-fable-'],
    ['claude-fable-5-1-20260601', 'claude-fable-'],
    ['bedrock.anthropic.claude-fable-5-1', 'claude-fable-'],
    ['anthropic/claude-fable-5-1', 'claude-fable-'],
    ['CLAUDE-FABLE-5-1', 'claude-fable-'],
    ['gpt-6-astra', 'gpt-6-astra'],
    ['gpt-6-astra-mini', 'gpt-6-astra'],
  ])('%s is denied by %s', (model, prefix) => {
    expect(planDeniedPrefix(PRO30, model)).toBe(prefix)
  })

  it.each(['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'gpt-6', 'gpt-5.6-sol', 'kimi-k3'])('%s is allowed', (model) => {
    expect(planDeniedPrefix(PRO30, model)).toBeNull()
  })

  it('an empty list restricts nothing', () => {
    expect(isDeniedByPlan([], 'claude-fable-5-1')).toBe(false)
  })

  it('keys on the canonical id: the family alias is not a versioned id', () => {
    // `fable` (the alias) does not start with `claude-fable-`; pickers resolve it first.
    expect(isDeniedByPlan(PRO30, 'fable')).toBe(false)
    expect(canonicalModelId('global.anthropic.claude-fable-5-1@20260601')).toBe('claude-fable-5-1')
  })
})

describe('normalizeDeniedModels', () => {
  it('keeps trimmed, lower-cased strings, like the proxy parse', () => {
    expect(normalizeDeniedModels(['  Claude-Fable- ', 3, '', null, 'gpt-6-astra'])).toEqual(['claude-fable-', 'gpt-6-astra'])
  })
  it('reads anything but an array as no restriction', () => {
    expect(normalizeDeniedModels(undefined)).toEqual([])
    expect(normalizeDeniedModels('claude-fable-')).toEqual([])
  })
})

describe('bestAllowedModel', () => {
  const denied = (m: { id: string }) => isDeniedByPlan(PRO30, m.id)
  const byId = (id: string) => PLATFORM_CATALOG.find((m) => m.id === id)!

  it('stays with the denied model\'s vendor: Fable falls back to Opus', () => {
    expect(bestAllowedModel(PLATFORM_CATALOG, denied, byId('claude-fable-5-1'))?.id).toBe('claude-opus-5-5')
  })

  it('Astra falls back to OpenAI\'s default', () => {
    expect(bestAllowedModel(PLATFORM_CATALOG, denied, byId('gpt-6-astra'))?.id).toBe('gpt-6.1-sol')
  })

  it('without a vendor hint, takes the catalog\'s first allowed default', () => {
    expect(bestAllowedModel(PLATFORM_CATALOG, denied)?.isDefault).toBe(true)
  })

  it('is undefined when the plan allows nothing in the catalog', () => {
    expect(bestAllowedModel([byId('claude-fable-5-1')], denied)).toBeUndefined()
  })
})

describe('excludedModelsLabel', () => {
  it('names each denylist entry by the one family it covers', () => {
    expect(excludedModelsLabel(PRO30, PLATFORM_CATALOG, familyName)).toBe('Claude Fable and GPT Astra')
  })
  it('is null for an unrestricted plan', () => {
    expect(excludedModelsLabel([], PLATFORM_CATALOG, familyName)).toBeNull()
  })
  it('reads a prefix spanning several families, or none, from the prefix itself', () => {
    expect(excludedModelsLabel(['gpt-6'], PLATFORM_CATALOG, familyName)).toBe('GPT 6')
    expect(excludedModelsLabel(['claude-fable-', 'nova-', 'gpt-6-astra'], PLATFORM_CATALOG, familyName))
      .toBe('Claude Fable, Nova and GPT Astra')
  })
})

describe('planModelLabel', () => {
  it('shows the catalog label for raw and vendor-prefixed ids', () => {
    expect(planModelLabel('claude-fable-5-1', PLATFORM_CATALOG)).toBe('Fable 5.1')
    expect(planModelLabel('bedrock.anthropic.claude-fable-5-1', PLATFORM_CATALOG)).toBe('Fable 5.1')
    expect(planModelLabel('mystery-model', PLATFORM_CATALOG)).toBe('mystery-model')
  })
})

describe('parseModelNotInPlan', () => {
  const body = { type: 'error', error: { type: 'model_not_in_plan', message: 'claude-fable-5-1 is not included…', model: 'claude-fable-5-1' } }

  it('reads the structured body', () => {
    expect(parseModelNotInPlan(body)).toEqual({ model: 'claude-fable-5-1' })
  })

  it('reads the CLI error line, with prose after the JSON', () => {
    expect(parseModelNotInPlan(`API Error: 403 ${JSON.stringify(body)} · Please run /login`)).toEqual({ model: 'claude-fable-5-1' })
  })

  it('recognizes the error type even when the JSON is cut off', () => {
    expect(parseModelNotInPlan('API Error: 403 {"type":"error","error":{"type":"model_not_in_plan","message":"cut')).toEqual({ model: null })
  })

  it('ignores every other error', () => {
    expect(parseModelNotInPlan('API Error: 402 {"error":"insufficient_balance"}')).toBeNull()
    expect(parseModelNotInPlan({ type: 'error', error: { type: 'permission_error' } })).toBeNull()
    expect(parseModelNotInPlan(undefined)).toBeNull()
  })
})
