import { describe, expect, it } from 'vitest'
import MODEL_PRICING from '../services/model-pricing.json'
import { pricingFor } from './model-pricing-lookup'

describe('pricingFor', () => {
  it('uses Sonnet 5 introductory rates before their cutoff', () => {
    expect(pricingFor('claude-sonnet-5', new Date('2026-08-20T12:00:00Z'))).toEqual({
      inputPerMtok: 2,
      outputPerMtok: 10,
      cacheCreationPerMtok: 2.5,
      cacheCreation1hPerMtok: 4,
      cacheReadPerMtok: 0.2,
    })
  })

  it('uses Sonnet 5 current rates at the historical cutoff', () => {
    expect(pricingFor('claude-sonnet-5', new Date('2026-09-01T00:00:00Z'))).toEqual({
      inputPerMtok: 3,
      outputPerMtok: 15,
      cacheCreationPerMtok: 3.75,
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
