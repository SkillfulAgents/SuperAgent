import type { SessionUsage } from '@shared/lib/types/agent'

/**
 * The context's size as of one API call: the uncached input plus what the
 * call read from and wrote to the cache. Every provider path reports usage
 * the Messages API way, with `input_tokens` counting only the uncached part,
 * so the three always add up.
 */
export function computeContextTokens(
  usage: Pick<SessionUsage, 'inputTokens' | 'cacheCreationInputTokens' | 'cacheReadInputTokens'>,
): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
}

/**
 * The context window usage percentage, or null when the window is not known
 * yet (0) or invalid.
 */
export function computeContextPercent(usage: SessionUsage): number | null {
  const { contextWindow } = usage
  if (contextWindow <= 0) return null
  return Math.round((computeContextTokens(usage) / contextWindow) * 100)
}
