import MODEL_PRICING from '../services/model-pricing.json'

interface PricingEntry {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

const PRICING = MODEL_PRICING as Record<string, PricingEntry>

/**
 * Display pricing for a catalog entry, seeded from model-pricing.json.
 * Returns undefined when the id has no known pricing (e.g. region-prefixed
 * Bedrock ids that aren't keyed there) — callers should pass a bare id for
 * Bedrock entries so display pricing still resolves.
 */
export function pricingFor(
  id: string,
): { inputPerMtok: number; outputPerMtok: number } | undefined {
  const entry = PRICING[id]
  if (!entry) return undefined
  return { inputPerMtok: entry.input, outputPerMtok: entry.output }
}
