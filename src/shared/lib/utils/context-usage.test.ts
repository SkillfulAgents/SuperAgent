import { describe, it, expect } from 'vitest'
import { computeContextPercent } from './context-usage'
import type { SessionUsage } from '@shared/lib/types/agent'

describe('computeContextPercent', () => {
  it('reads the CLI count against the window', () => {
    expect(computeContextPercent({ totalTokens: 64_041, contextWindow: 1_000_000 })).toBe(6)
    expect(computeContextPercent({ totalTokens: 250_000, contextWindow: 500_000 })).toBe(50)
  })

  it('can read over 100% when the count passes the window', () => {
    expect(computeContextPercent({ totalTokens: 210_000, contextWindow: 200_000 })).toBe(105)
  })

  it('shows no percentage without a window', () => {
    expect(computeContextPercent({ totalTokens: 1_000, contextWindow: 0 })).toBeNull()
    expect(computeContextPercent({ totalTokens: 1_000, contextWindow: -1 })).toBeNull()
  })

  it('shows no percentage for a size saved before the CLI count', () => {
    const saved = { inputTokens: 150_000, outputTokens: 1_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, contextWindow: 200_000 }
    expect(computeContextPercent(saved as unknown as SessionUsage)).toBeNull()
  })
})
