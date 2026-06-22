import type { SessionUsage } from '../types/agent'

/** Current context occupancy ≈ what the next message re-reads (last turn's input side). */
export function currentContextTokens(
  usage: Pick<SessionUsage, 'inputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'> | null | undefined,
): number {
  if (!usage) return 0
  return (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
}
