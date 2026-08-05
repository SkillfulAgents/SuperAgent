import type { SessionUsage } from '@shared/lib/types/agent'

/**
 * Compute current context occupancy across both Anthropic usage formats:
 * older responses report uncached input separately, while newer responses may
 * report inputTokens as the total with cache fields as subsets.
 */
export function computeContextTokens(
  usage: Pick<SessionUsage, 'inputTokens' | 'cacheCreationInputTokens' | 'cacheReadInputTokens'>,
): number {
  const { inputTokens, cacheCreationInputTokens, cacheReadInputTokens } = usage
  const cacheTotal = cacheCreationInputTokens + cacheReadInputTokens
  return cacheTotal > 0 && inputTokens >= cacheTotal
    ? inputTokens
    : inputTokens + cacheTotal
}

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
  const { contextWindow } = usage
  if (contextWindow <= 0) return null
  return Math.round((computeContextTokens(usage) / contextWindow) * 100)
}
