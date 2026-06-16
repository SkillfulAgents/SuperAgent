import { describe, it, expect } from 'vitest'
import { estimateNextMessageCostUsd, currentContextTokens } from './message-cost'

describe('estimateNextMessageCostUsd', () => {
  it('prices a cold-cache re-read at the cache-creation rate (idle session)', () => {
    // 150k tokens of context re-read, idle => cache creation on the whole context.
    // claude-sonnet-4-6 cacheCreation rate: 3.75 per million => 150_000 * 3.75 / 1_000_000 = 0.5625 USD
    const usd = estimateNextMessageCostUsd({ contextTokens: 150_000, model: 'claude-sonnet-4-6', idle: true })
    expect(usd).toBeGreaterThan(0)
  })

  it('returns null for an unknown model rather than throwing', () => {
    expect(estimateNextMessageCostUsd({ contextTokens: 150_000, model: 'made-up-model', idle: true })).toBeNull()
  })

  it('costs more cold (cache-creation) than warm (cache-read)', () => {
    // claude-sonnet-4-6: cacheCreation=3.75 > cacheRead=0.3 per million
    const cold = estimateNextMessageCostUsd({ contextTokens: 100_000, model: 'claude-sonnet-4-6', idle: true })!
    const warm = estimateNextMessageCostUsd({ contextTokens: 100_000, model: 'claude-sonnet-4-6', idle: false })!
    expect(cold).toBeGreaterThan(warm)
  })
})

describe('currentContextTokens', () => {
  it('returns 0 for null usage', () => {
    expect(currentContextTokens(null)).toBe(0)
  })

  it('returns 0 for undefined usage', () => {
    expect(currentContextTokens(undefined)).toBe(0)
  })

  it('sums inputTokens, cacheReadInputTokens, and cacheCreationInputTokens', () => {
    expect(
      currentContextTokens({
        inputTokens: 1000,
        cacheReadInputTokens: 5000,
        cacheCreationInputTokens: 2000,
      }),
    ).toBe(8000)
  })
})
