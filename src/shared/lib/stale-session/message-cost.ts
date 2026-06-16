import { getModelPricing } from '../services/usage-service'
import type { SessionUsage } from '../types/agent'

/** Current context occupancy ≈ what the next message re-reads (last turn's input side). */
export function currentContextTokens(
  usage: Pick<SessionUsage, 'inputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'> | null | undefined,
): number {
  if (!usage) return 0
  return (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
}

/** Rough USD cost of sending the next message: re-reading `contextTokens` of context.
 *  Idle => cold cache => cache-creation rate on the whole context (the honest "cost to come back").
 *  Output excluded (unpredictable; input dominates for the sessions we prompt on). Null if model unknown.
 *  Note: pricing rates are per-million tokens, so we divide by 1_000_000. */
export function estimateNextMessageCostUsd({
  contextTokens,
  model,
  idle,
}: {
  contextTokens: number
  model: string
  idle: boolean
}): number | null {
  const p = getModelPricing(model)
  if (!p) return null
  const ratePerMillion = idle ? p.cacheCreation : p.cacheRead
  return (contextTokens * ratePerMillion) / 1_000_000
}
