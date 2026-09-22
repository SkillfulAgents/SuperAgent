import { describe, expect, it } from 'vitest'
import {
  getPricingRefreshDriftWarnings,
  mergeRefreshedModelPricing,
  type ModelPricingTable,
} from '../../../../scripts/lib/model-pricing-merge'

describe('mergeRefreshedModelPricing', () => {
  it('updates flat Claude rates while preserving curated metadata and non-Claude entries', () => {
    const existing = {
      'claude-scheduled-model': {
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
      'claude-scheduled-model': {
        input: 4,
        output: 20,
        cacheCreation: 5,
        cacheRead: 0.4,
      },
    })

    expect(merged['claude-scheduled-model']).toEqual({
      input: 4,
      output: 20,
      cacheCreation: 5,
      cacheCreation1h: 6,
      cacheRead: 0.4,
      historicalRates: existing['claude-scheduled-model'].historicalRates,
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
      'claude-scheduled-model',
      'gpt-5.6-sol',
    ])
  })

  it('warns when preserved cache-duration and tier rates drift from refreshed bases', () => {
    const existing = {
      'claude-tiered-model': {
        input: 3,
        output: 15,
        cacheCreation: 3.75,
        cacheCreation1h: 6,
        cacheRead: 0.3,
        marginalLongContext: {
          thresholdTokens: 200_000,
          input: 6,
          output: 22.5,
          cacheCreation: 7.5,
          cacheCreation1h: 12,
          cacheRead: 0.6,
        },
        speedMultipliers: { fast: 2 },
      },
      'claude-flat-model': {
        input: 1,
        output: 5,
        cacheCreation: 1.25,
        cacheRead: 0.1,
        speedMultipliers: { fast: 2 },
      },
    } as ModelPricingTable
    const refreshed = {
      'claude-tiered-model': {
        input: 2,
        output: 10,
        cacheCreation: 2.5,
        cacheRead: 0.2,
      },
      'claude-flat-model': {
        input: 2,
        output: 10,
        cacheCreation: 2.5,
        cacheRead: 0.2,
      },
    }

    const warnings = getPricingRefreshDriftWarnings(existing, refreshed)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('cacheCreation1h/input 2x -> 3x')
    expect(warnings[0]).toContain('marginalLongContext.input/input 2x -> 3x')
    expect(warnings[0]).toContain('marginalLongContext.output/output 1.5x -> 2.25x')
    expect(warnings[0]).toContain('marginalLongContext.cacheCreation/cacheCreation 2x -> 3x')
    expect(warnings[0]).toContain('marginalLongContext.cacheRead/cacheRead 2x -> 3x')
    // Both one-hour absolute rates are preserved, so their mutual 2x ratio does not drift.
    expect(warnings[0]).not.toContain('marginalLongContext.cacheCreation1h')

    // Warning detection is advisory only; merge behavior remains unchanged.
    expect(mergeRefreshedModelPricing(existing, refreshed)['claude-tiered-model']).toEqual({
      ...existing['claude-tiered-model'],
      ...refreshed['claude-tiered-model'],
    })
  })
})
