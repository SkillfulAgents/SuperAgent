import { describe, expect, it } from 'vitest'
import {
  extractCatalogPricing,
  findGlobalPrice,
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
      ).toMatchObject(price)
    }
    expect(canonicalPricingId('openai/gpt-5.5')).toBe('gpt-5.5')
    expect(canonicalPricingId('private-deployment-west')).toBe('private-deployment-west')
    expect(canonicalPricingId('openai/gpt-5.5:thinking')).toBe('openai/gpt-5.5:thinking')
  })

  it('prices a dated or suffixed runtime id from its custom model, most specific key first', () => {
    const prices = patchGlobalModelPricing({}, { 'qwen/qwen3-max': price })
    expect(prices).toEqual({ 'qwen/qwen3-max': price })
    for (const runtimeId of ['qwen/qwen3-max', 'qwen/qwen3-max-20260101', 'qwen/qwen3-max@2026-01-01']) {
      expect(findGlobalPrice(runtimeId, prices)).toEqual(price)
    }
    expect(findGlobalPrice('qwen/qwen3-coder', prices)).toBeUndefined()
    // Object keys are not prices.
    expect(findGlobalPrice('constructor', prices)).toBeUndefined()
  })

  it('keeps a foreign-prefixed deployment off the built-in model key', () => {
    const shared = { inputPerMtok: 5, outputPerMtok: 30 }
    expect(canonicalPricingId('azure/gpt-5.5')).toBe('azure/gpt-5.5')
    expect(canonicalPricingId('azure/gpt-5.5-20260423')).toBe('azure/gpt-5.5-20260423')

    // Pricing the deployment leaves the shared gpt-5.5 override alone...
    const prices = patchGlobalModelPricing({ 'gpt-5.5': shared }, { 'azure/gpt-5.5': price })
    expect(prices).toEqual({ 'gpt-5.5': shared, 'azure/gpt-5.5': price })
    expect(findGlobalPrice('azure/gpt-5.5-20260423', prices)).toEqual(price)
    expect(findGlobalPrice('openai/gpt-5.5', prices)).toEqual(shared)

    // ...and so does clearing it, after which it falls back to the shared rate.
    const cleared = patchGlobalModelPricing(prices, { 'azure/gpt-5.5': null })
    expect(cleared).toEqual({ 'gpt-5.5': shared })
    expect(findGlobalPrice('azure/gpt-5.5', cleared)).toEqual(shared)
  })

  it('shows an input/output override with the cache ratios and speed tiers that are billed', () => {
    const builtin = pricingFor('gpt-5.5')!
    const [model] = withGlobalModelPricing(
      [{ id: 'openai/gpt-5.5', label: 'GPT', supportedEfforts: ['low'] }],
      { 'gpt-5.5': { inputPerMtok: builtin.inputPerMtok * 2, outputPerMtok: 1 } },
    )
    expect(model.pricing?.outputPerMtok).toBe(1)
    expect(model.pricing?.cacheReadPerMtok).toBeCloseTo(builtin.cacheReadPerMtok! * 2, 9)
    expect(model.pricing?.cacheCreationPerMtok).toBeCloseTo(builtin.cacheCreationPerMtok! * 2, 9)
    expect(model.pricing?.speedMultipliers).toEqual(builtin.speedMultipliers)

    // An explicit cache rate is never re-derived, and a model with no built-in card shows the override as is.
    const explicit = { inputPerMtok: 9, outputPerMtok: 9, cacheReadPerMtok: 0 }
    expect(
      withGlobalModelPricing([{ id: 'gpt-5.5', label: 'GPT', supportedEfforts: ['low'] }], { 'gpt-5.5': explicit })[0]
        .pricing?.cacheReadPerMtok,
    ).toBe(0)
    expect(
      withGlobalModelPricing([{ id: 'private', label: 'P', supportedEfforts: ['low'] }], { private: price })[0].pricing,
    ).toEqual(price)
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

  it('does not import a legacy price that only restates the built-in rate', () => {
    const current = pricingFor('claude-sonnet-5')!
    const legacy = {
      anthropic: {
        overrides: [
          {
            id: 'claude-sonnet-5',
            disabled: true,
            pricing: { inputPerMtok: current.inputPerMtok, outputPerMtok: current.outputPerMtok },
          },
          { id: 'claude-opus-4-8', pricing: { inputPerMtok: 1, outputPerMtok: 1 } },
        ],
      },
    }
    const result = extractCatalogPricing(legacy, 'anthropic')
    expect(result.pricing).toEqual({ 'claude-opus-4-8': { inputPerMtok: 1, outputPerMtok: 1 } })
    expect(result.catalog.anthropic.overrides).toEqual([
      { id: 'claude-sonnet-5', disabled: true },
      { id: 'claude-opus-4-8' },
    ])
  })

  it('resolves provider precedence before dropping a restated price', () => {
    const builtin = pricingFor('claude-opus-4-8')!
    const restated = { inputPerMtok: builtin.inputPerMtok, outputPerMtok: builtin.outputPerMtok }
    const legacy = {
      anthropic: { overrides: [{ id: 'claude-opus-4-8', pricing: restated }] },
      bedrock: {
        overrides: [{ id: 'us.anthropic.claude-opus-4-8', pricing: { inputPerMtok: 9, outputPerMtok: 45 } }],
      },
    }
    // Active Anthropic wins the key with the built-in rate, so nothing is overridden:
    // the inactive Bedrock price must not slip in behind it.
    expect(extractCatalogPricing(legacy, 'anthropic').pricing).toEqual({})
    // With Bedrock active, its price is the winner and a real override.
    expect(extractCatalogPricing(legacy, 'bedrock').pricing).toEqual({
      'claude-opus-4-8': { inputPerMtok: 9, outputPerMtok: 45 },
    })
  })

  it('imports built-in token rates that carry their own speed multiplier', () => {
    const builtin = pricingFor('claude-opus-4-8')!
    const pricing = {
      inputPerMtok: builtin.inputPerMtok,
      outputPerMtok: builtin.outputPerMtok,
      speedMultipliers: { fast: 9 },
    }
    const legacy = { anthropic: { overrides: [{ id: 'claude-opus-4-8', pricing }] } }
    expect(extractCatalogPricing(legacy, 'anthropic').pricing).toEqual({ 'claude-opus-4-8': pricing })
  })
})
