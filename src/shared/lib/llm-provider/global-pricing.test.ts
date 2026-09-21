import { describe, expect, it } from 'vitest'
import {
  extractCatalogPricing,
  patchGlobalModelPricing,
  withGlobalModelPricing,
} from './global-pricing'
import { canonicalPricingId } from './model-pricing-ids'
import { pricingFor } from './model-pricing-lookup'

const price = { inputPerMtok: 7, outputPerMtok: 21 }
describe('global model pricing', () => {
  it('gives provider-qualified and dated IDs one override key', () => {
    for (const id of [
      'claude-sonnet-5',
      'anthropic/claude-sonnet-5-20260630',
      'us.anthropic.claude-sonnet-5-v1:0',
    ]) {
      expect(canonicalPricingId(id)).toBe('claude-sonnet-5')
      const prices = patchGlobalModelPricing({}, { [id]: price })
      expect(prices).toEqual({ 'claude-sonnet-5': price })
      expect(
        withGlobalModelPricing([{ id, label: id, supportedEfforts: ['low'] }], prices)[0].pricing,
      ).toEqual(price)
    }
    expect(canonicalPricingId('openai/gpt-5.5')).toBe('gpt-5.5')
    expect(canonicalPricingId('private-deployment-west')).toBe('private-deployment-west')
    expect(canonicalPricingId('openai/gpt-5.5:thinking')).toBe('openai/gpt-5.5:thinking')
  })

  it('shares base rates, including speed multipliers, across providers', () => {
    expect(pricingFor('openai/gpt-5.5')).toEqual(pricingFor('gpt-5.5'))
    expect(pricingFor('x-ai/grok-4.7')).toEqual(pricingFor('grok-4.7'))
    expect(pricingFor('moonshotai/kimi-k3')).toEqual(pricingFor('kimi-k3'))
  })

  it('patches one model without losing others, and null resets the canonical price', () => {
    const existing = { other: price, 'gpt-5.5': price }
    expect(patchGlobalModelPricing(existing, { 'openai/gpt-5.5': null })).toEqual({ other: price })
    expect(existing['gpt-5.5']).toEqual(price)
    expect(() =>
      patchGlobalModelPricing({}, { bad: { inputPerMtok: -1, outputPerMtok: 1 } }),
    ).toThrow()
  })

  it('preserves the active provider on legacy conflicts, with deterministic fallback and no catalog prices', () => {
    const legacy = {
      anthropic: { overrides: [{ id: 'claude-sonnet-5', pricing: price, disabled: true }] },
      bedrock: {
        overrides: [
          { id: 'us.anthropic.claude-sonnet-5', pricing: { inputPerMtok: 2, outputPerMtok: 3 } },
        ],
      },
      generic: { overrides: [{ id: 'private-model', label: 'Custom', pricing: price }] },
    }
    const result = extractCatalogPricing(legacy, 'bedrock')
    expect(result.pricing).toEqual({
      'claude-sonnet-5': { inputPerMtok: 2, outputPerMtok: 3 },
      'private-model': price,
    })
    expect(result.catalog.anthropic.overrides).toEqual([{ id: 'claude-sonnet-5', disabled: true }])
    expect(JSON.stringify(result.catalog)).not.toContain('pricing')
    expect(legacy.anthropic.overrides[0].pricing).toEqual(price)
  })
})
