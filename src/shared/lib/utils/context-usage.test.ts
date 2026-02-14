import { describe, it, expect } from 'vitest'
import { computeContextPercent } from './context-usage'
import type { SessionUsage } from '@shared/lib/types/agent'

function usage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    contextWindow: 200_000,
    ...overrides,
  }
}

describe('computeContextPercent', () => {
  describe('new API format (input_tokens includes cached)', () => {
    it('computes percent when input_tokens is the total', () => {
      // 40k total tokens, 30k from cache read, 10k from cache creation
      // input_tokens = 40k (already the total)
      const result = computeContextPercent(usage({
        inputTokens: 40_000,
        cacheCreationInputTokens: 10_000,
        cacheReadInputTokens: 30_000,
        contextWindow: 200_000,
      }))
      expect(result).toBe(20)
    })

    it('does not double-count cached tokens', () => {
      // If we naively summed: 40k + 10k + 30k = 80k → 40%
      // Correct (new format): 40k → 20%
      const result = computeContextPercent(usage({
        inputTokens: 40_000,
        cacheCreationInputTokens: 10_000,
        cacheReadInputTokens: 30_000,
        contextWindow: 200_000,
      }))
      expect(result).toBe(20)
      expect(result).not.toBe(40)
    })

    it('handles cache hit only (no creation)', () => {
      const result = computeContextPercent(usage({
        inputTokens: 50_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 45_000,
        contextWindow: 200_000,
      }))
      expect(result).toBe(25)
    })

    it('handles cache creation only (no read)', () => {
      const result = computeContextPercent(usage({
        inputTokens: 50_000,
        cacheCreationInputTokens: 45_000,
        cacheReadInputTokens: 0,
        contextWindow: 200_000,
      }))
      expect(result).toBe(25)
    })
  })

  describe('old API format (input_tokens is non-cached only)', () => {
    it('sums input + cache fields when input < cache total', () => {
      // Old format: input_tokens = 5k (non-cached), cache fields = 35k
      // Total = 5k + 35k = 40k
      const result = computeContextPercent(usage({
        inputTokens: 5_000,
        cacheCreationInputTokens: 10_000,
        cacheReadInputTokens: 25_000,
        contextWindow: 200_000,
      }))
      expect(result).toBe(20)
    })
  })

  describe('no caching', () => {
    it('uses input_tokens directly when cache fields are zero', () => {
      const result = computeContextPercent(usage({
        inputTokens: 30_000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        contextWindow: 200_000,
      }))
      expect(result).toBe(15)
    })
  })

  describe('edge cases', () => {
    it('returns null when contextWindow is zero', () => {
      const result = computeContextPercent(usage({
        inputTokens: 10_000,
        contextWindow: 0,
      }))
      expect(result).toBeNull()
    })

    it('returns null when contextWindow is negative', () => {
      const result = computeContextPercent(usage({
        inputTokens: 10_000,
        contextWindow: -1,
      }))
      expect(result).toBeNull()
    })

    it('returns 0 when all token fields are zero', () => {
      const result = computeContextPercent(usage({
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        contextWindow: 200_000,
      }))
      expect(result).toBe(0)
    })

    it('allows values over 100%', () => {
      const result = computeContextPercent(usage({
        inputTokens: 250_000,
        contextWindow: 200_000,
      }))
      expect(result).toBe(125)
    })

    it('rounds to nearest integer', () => {
      const result = computeContextPercent(usage({
        inputTokens: 1,
        contextWindow: 3,
      }))
      expect(result).toBe(33)
    })
  })
})
