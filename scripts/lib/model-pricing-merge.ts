export interface FlatModelPricing {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

export type ModelPricingEntry = FlatModelPricing & Record<string, unknown>
export type ModelPricingTable = Record<string, ModelPricingEntry>

/**
 * Overlay freshly fetched flat rates without discarding curated metadata.
 *
 * The checked-in table also carries effective-dated rates, context tiers, cache
 * duration pricing, and speed multipliers that LiteLLM's four flat fields cannot
 * represent. Non-Claude provider entries live in the same table. A refresh may
 * update or add flat Claude cards, but must preserve all of that other data.
 */
export function mergeRefreshedModelPricing(
  existing: ModelPricingTable,
  refreshed: Record<string, FlatModelPricing>,
): ModelPricingTable {
  const merged: ModelPricingTable = { ...existing }

  for (const [id, flatRates] of Object.entries(refreshed)) {
    merged[id] = {
      ...(existing[id] ?? {}),
      ...flatRates,
    } as ModelPricingEntry
  }

  return Object.fromEntries(
    Object.keys(merged)
      .sort()
      .map((id) => [id, merged[id]]),
  )
}
