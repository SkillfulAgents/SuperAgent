import type { SessionUsage } from '@shared/lib/types/agent'

/** The context window usage percentage, or null when there is no size or window to read. */
export function computeContextPercent(usage: SessionUsage): number | null {
  const { totalTokens, contextWindow } = usage
  // Sizes saved before the CLI's count have no totalTokens.
  if (typeof totalTokens !== 'number' || !(contextWindow > 0)) return null
  return Math.round((totalTokens / contextWindow) * 100)
}
