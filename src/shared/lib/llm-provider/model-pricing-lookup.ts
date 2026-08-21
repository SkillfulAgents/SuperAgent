import MODEL_PRICING from '../services/model-pricing.json'

interface SpeedMultipliers {
  slow?: number
  fast?: number
}

interface PricingEntry {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
  speedMultipliers?: SpeedMultipliers
}

const PRICING = MODEL_PRICING as Record<string, PricingEntry>

/**
 * Display pricing for a catalog entry, seeded from model-pricing.json.
 * Returns undefined when the id has no known pricing (e.g. region-prefixed
 * Bedrock ids that aren't keyed there) — callers should pass a bare id for
 * Bedrock entries so display pricing still resolves.
 *
 * Served-tier speed multipliers ride along so catalog entries seeded here
 * (e.g. Opus 4.8's 2x fast mode) bill speed rows correctly.
 */
export function pricingFor(
  id: string,
):
  | { inputPerMtok: number; outputPerMtok: number; speedMultipliers?: SpeedMultipliers }
  | undefined {
  const entry = PRICING[id]
  if (!entry) return undefined
  return {
    inputPerMtok: entry.input,
    outputPerMtok: entry.output,
    ...(entry.speedMultipliers ? { speedMultipliers: entry.speedMultipliers } : {}),
  }
}
