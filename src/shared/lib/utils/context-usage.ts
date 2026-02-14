import type { SessionUsage } from '@shared/lib/types/agent'

/**
 * Compute the context window usage percentage from token usage fields.
 *
 * The Anthropic API has two formats:
 *   Old: input_tokens = non-cached only; total = input + cache_creation + cache_read
 *   New: input_tokens = total (includes cached); cache_* are subsets
 *
 * We detect which by checking if input_tokens already covers the cache fields.
 *
 * Returns null if contextWindow is invalid (zero or negative).
 */
export function computeContextPercent(usage: SessionUsage): number | null {
  const { inputTokens, cacheCreationInputTokens, cacheReadInputTokens, contextWindow } = usage
  if (contextWindow <= 0) return null
  const cacheTotal = cacheCreationInputTokens + cacheReadInputTokens
  const totalTokens = (cacheTotal > 0 && inputTokens >= cacheTotal)
    ? inputTokens                    // New format: input_tokens is already the total
    : inputTokens + cacheTotal       // Old format: add cache fields
  return Math.round((totalTokens / contextWindow) * 100)
}
