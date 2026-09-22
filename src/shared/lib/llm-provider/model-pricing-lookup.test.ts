import { describe, expect, it, vi } from 'vitest'
import MODEL_PRICING from '../services/model-pricing.json'
import { pricingFor, restatesBuiltinRate } from './model-pricing-lookup'

vi.mock('../services/model-pricing.json', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof MODEL_PRICING }>()
  return {
    default: {
      ...actual.default,
      'synthetic-effective-dated-model': {
        input: 3,
        output: 15,
        cacheCreation: 3.75,
        cacheCreation1h: 6,
        cacheRead: 0.3,
        historicalRates: [
          {
            before: '2030-01-01T00:00:00Z',
            input: 2,
            output: 10,
            cacheCreation: 2.5,
            cacheCreation1h: 4,
            cacheRead: 0.2,
          },
        ],
      },
    },
  }
})

describe('restatesBuiltinRate', () => {
  it('recognizes the current card and a historical one, through an alias, and nothing else', () => {
    const id = 'vendor/synthetic-effective-dated-model-20260101'
    expect(restatesBuiltinRate(id, { inputPerMtok: 3, outputPerMtok: 15 })).toBe(true)
    expect(restatesBuiltinRate(id, { inputPerMtok: 2, outputPerMtok: 10, cacheReadPerMtok: 0.2 })).toBe(true)
    // Mixing the two cards, or changing any rate, is a real override.
    expect(restatesBuiltinRate(id, { inputPerMtok: 3, outputPerMtok: 10 })).toBe(false)
    expect(restatesBuiltinRate(id, { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0 })).toBe(false)
    expect(restatesBuiltinRate('unknown-model', { inputPerMtok: 3, outputPerMtok: 15 })).toBe(false)
  })

  it('treats a changed speed multiplier as an override even at the built-in token rates', () => {
    const builtin = pricingFor('claude-opus-4-8')!
    const rates = { inputPerMtok: builtin.inputPerMtok, outputPerMtok: builtin.outputPerMtok }
    expect(builtin.speedMultipliers).toEqual({ fast: 2 })
    expect(restatesBuiltinRate('claude-opus-4-8', { ...rates, speedMultipliers: { fast: 2 } })).toBe(true)
    expect(restatesBuiltinRate('claude-opus-4-8', { ...rates, speedMultipliers: { fast: 9 } })).toBe(false)
    expect(restatesBuiltinRate('claude-opus-4-8', { ...rates, speedMultipliers: { slow: 0.5, fast: 2 } })).toBe(false)
    // A model whose card has no speed tiers: declaring one is an override.
    expect(restatesBuiltinRate('claude-sonnet-5', { inputPerMtok: 2, outputPerMtok: 10, speedMultipliers: { fast: 2 } })).toBe(false)
  })
})

describe('pricingFor', () => {
  it.each(['2026-08-20T12:00:00Z', '2026-09-01T00:00:00Z', '2027-01-01T00:00:00Z'])(
    'uses Sonnet 5 permanent rates at %s',
    (at) => {
      expect(pricingFor('claude-sonnet-5', new Date(at))).toEqual({
        inputPerMtok: 2,
        outputPerMtok: 10,
        cacheCreationPerMtok: 2.5,
        cacheCreation1hPerMtok: 4,
        cacheReadPerMtok: 0.2,
      })
    },
  )

  it('uses an effective-dated historical rate strictly before its cutoff', () => {
    expect(
      pricingFor('synthetic-effective-dated-model', new Date('2029-12-31T23:59:59Z')),
    ).toEqual({
      inputPerMtok: 2,
      outputPerMtok: 10,
      cacheCreationPerMtok: 2.5,
      cacheCreation1hPerMtok: 4,
      cacheReadPerMtok: 0.2,
    })
    expect(
      pricingFor('synthetic-effective-dated-model', new Date('2030-01-01T00:00:00Z')),
    ).toEqual({
      inputPerMtok: 3,
      outputPerMtok: 15,
      cacheCreationPerMtok: 3.75,
      cacheCreation1hPerMtok: 6,
      cacheReadPerMtok: 0.3,
    })
  })

  it('exposes Opus 5 base, cache-duration, and fast-mode pricing separately', () => {
    expect(pricingFor('claude-opus-5')).toEqual({
      inputPerMtok: 5,
      outputPerMtok: 25,
      cacheCreationPerMtok: 6.25,
      cacheCreation1hPerMtok: 10,
      cacheReadPerMtok: 0.5,
      speedMultipliers: { fast: 2 },
    })
  })

  it('exposes Opus 5.5 pricing: cheaper than Opus 5 with the same fast-mode multiplier', () => {
    expect(pricingFor('claude-opus-5-5')).toEqual({
      inputPerMtok: 4,
      outputPerMtok: 20,
      cacheCreationPerMtok: 5,
      cacheCreation1hPerMtok: 8,
      cacheReadPerMtok: 0.2,
      speedMultipliers: { fast: 2 },
    })
  })

  it.each(['claude-opus-4-6', 'claude-opus-4-6-20260205', 'claude-opus-4-7'])(
    'retains the historical 6x fast multiplier for %s',
    (id) => {
      expect(pricingFor(id)?.speedMultipliers).toEqual({ fast: 6 })
    },
  )
})

describe('historical Claude long-context pricing data', () => {
  it.each(['claude-4-sonnet-20250514', 'claude-sonnet-4-20250514'] as const)(
    'stores marginal rates for %s',
    (id) => {
      expect(MODEL_PRICING[id].marginalLongContext).toEqual({
        thresholdTokens: 200_000,
        input: 6,
        output: 22.5,
        cacheCreation: 7.5,
        cacheCreation1h: 12,
        cacheRead: 0.6,
      })
    },
  )
})
