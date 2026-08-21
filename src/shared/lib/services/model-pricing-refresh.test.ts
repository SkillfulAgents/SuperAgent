import { describe, expect, it } from 'vitest'
import {
  mergeRefreshedModelPricing,
  type ModelPricingTable,
} from '../../../../scripts/lib/model-pricing-merge'

describe('mergeRefreshedModelPricing', () => {
  it('updates flat Claude rates while preserving curated metadata and non-Claude entries', () => {
    const existing = {
      'claude-sonnet-5': {
        input: 3,
        output: 15,
        cacheCreation: 3.75,
        cacheCreation1h: 6,
        cacheRead: 0.3,
        historicalRates: [
          {
            before: '2026-09-01T00:00:00Z',
            input: 2,
            output: 10,
            cacheCreation: 2.5,
            cacheCreation1h: 4,
            cacheRead: 0.2,
          },
        ],
        speedMultipliers: { fast: 2 },
      },
      'claude-retired-model': {
        input: 8,
        output: 24,
        cacheCreation: 10,
        cacheRead: 0.8,
        marginalLongContext: { thresholdTokens: 200_000, input: 16 },
      },
      'gpt-5.6-sol': {
        input: 5,
        output: 30,
        cacheCreation: 5,
        cacheRead: 0.5,
        longContext: { thresholdTokens: 272_000, input: 10, output: 45 },
      },
    } as ModelPricingTable

    const merged = mergeRefreshedModelPricing(existing, {
      'claude-new-model': {
        input: 1,
        output: 5,
        cacheCreation: 1.25,
        cacheRead: 0.1,
      },
      'claude-sonnet-5': {
        input: 4,
        output: 20,
        cacheCreation: 5,
        cacheRead: 0.4,
      },
    })

    expect(merged['claude-sonnet-5']).toEqual({
      input: 4,
      output: 20,
      cacheCreation: 5,
      cacheCreation1h: 6,
      cacheRead: 0.4,
      historicalRates: existing['claude-sonnet-5'].historicalRates,
      speedMultipliers: { fast: 2 },
    })
    expect(merged['claude-retired-model']).toEqual(existing['claude-retired-model'])
    expect(merged['gpt-5.6-sol']).toEqual(existing['gpt-5.6-sol'])
    expect(merged['claude-new-model']).toEqual({
      input: 1,
      output: 5,
      cacheCreation: 1.25,
      cacheRead: 0.1,
    })
    expect(Object.keys(merged)).toEqual([
      'claude-new-model',
      'claude-retired-model',
      'claude-sonnet-5',
      'gpt-5.6-sol',
    ])
  })
})
