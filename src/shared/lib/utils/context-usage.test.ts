import { describe, it, expect } from 'vitest'
import { computeContextPercent, computeContextTokens } from './context-usage'
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

describe('computeContextTokens', () => {
  it('adds the uncached input to what the call read from and wrote to the cache', () => {
    expect(computeContextTokens(usage({
      inputTokens: 2,
      cacheCreationInputTokens: 218,
      cacheReadInputTokens: 101_514,
    }))).toBe(101_734)
  })

  it('keeps the cached part when the uncached input is the larger one (a partial OpenAI cache hit)', () => {
    // GPT-6 Sol through the translation layer: 51,300 uncached, 39,424 cached.
    expect(computeContextTokens(usage({
      inputTokens: 51_300,
      cacheReadInputTokens: 39_424,
    }))).toBe(90_724)
  })

  it('is the input alone when nothing was cached', () => {
    expect(computeContextTokens(usage({ inputTokens: 30_000 }))).toBe(30_000)
  })
})

describe('computeContextPercent', () => {
  it('divides the context size by the window', () => {
    expect(computeContextPercent(usage({
      inputTokens: 5_000,
      cacheCreationInputTokens: 10_000,
      cacheReadInputTokens: 25_000,
      contextWindow: 200_000,
    }))).toBe(20)
  })

  it('reads a 1M-window model against its own window', () => {
    expect(computeContextPercent(usage({
      inputTokens: 2,
      cacheCreationInputTokens: 1_451,
      cacheReadInputTokens: 232_569,
      contextWindow: 1_000_000,
    }))).toBe(23)
  })

  it('returns null when the window is not known yet (0)', () => {
    expect(computeContextPercent(usage({ inputTokens: 10_000, contextWindow: 0 }))).toBeNull()
  })

  it('returns null when the window is negative', () => {
    expect(computeContextPercent(usage({ inputTokens: 10_000, contextWindow: -1 }))).toBeNull()
  })

  it('returns 0 when all token fields are zero', () => {
    expect(computeContextPercent(usage())).toBe(0)
  })

  it('allows values over 100%', () => {
    expect(computeContextPercent(usage({ inputTokens: 250_000, contextWindow: 200_000 }))).toBe(125)
  })

  it('rounds to the nearest integer', () => {
    expect(computeContextPercent(usage({ inputTokens: 1, contextWindow: 3 }))).toBe(33)
  })
})
