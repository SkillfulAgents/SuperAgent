import { describe, it, expect } from 'vitest'
import { sessionMetadataSchema } from './session-metadata-schema'
import { computeContextPercent } from '@shared/lib/utils/context-usage'
import type { SessionUsage } from '@shared/lib/types/agent'

const lastUsageOf = (lastUsage: unknown) => sessionMetadataSchema.parse({ lastUsage }).lastUsage

describe('session metadata lastUsage', () => {
  it('keeps a size the CLI counted', () => {
    expect(lastUsageOf({ totalTokens: 64_041, contextWindow: 1_000_000 })).toEqual({ totalTokens: 64_041, contextWindow: 1_000_000 })
  })

  it('counts a size saved before the CLI count as the CLI does, without its guessed window', () => {
    const upgraded = lastUsageOf({
      inputTokens: 1_200,
      outputTokens: 800,
      cacheCreationInputTokens: 3_000,
      cacheReadInputTokens: 229_022,
      contextWindow: 200_000,
    })

    expect(upgraded).toEqual({ totalTokens: 234_022, contextWindow: 0 })
    expect(computeContextPercent(upgraded as SessionUsage)).toBeNull()
  })

  it('counts missing cache and output fields of an old size as zero', () => {
    expect(lastUsageOf({ inputTokens: 150_000, contextWindow: 200_000 })).toEqual({ totalTokens: 150_000, contextWindow: 0 })
  })

  it('leaves a value with neither shape to the lenient schema', () => {
    expect(lastUsageOf({ contextWindow: 200_000 })).toEqual({ contextWindow: 200_000 })
    expect(lastUsageOf(undefined)).toBeUndefined()
  })
})
