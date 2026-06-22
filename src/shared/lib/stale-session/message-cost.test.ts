import { describe, it, expect } from 'vitest'
import { currentContextTokens } from './message-cost'

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
