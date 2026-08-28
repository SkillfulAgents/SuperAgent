import MODEL_PRICING from '../services/model-pricing.json'

interface SpeedMultipliers {
  slow?: number
  fast?: number
}

interface PricingRates {
  input: number
  output: number
  cacheCreation: number
  cacheCreation1h?: number
  cacheRead: number
}

interface HistoricalPricingRates extends PricingRates {
  /** This rate card applies strictly before this ISO-8601 instant. */
  before: string
}

interface PricingEntry extends PricingRates {
  speedMultipliers?: SpeedMultipliers
  historicalRates?: HistoricalPricingRates[]
}

const PRICING = MODEL_PRICING as Record<string, PricingEntry>

function effectiveRates(entry: PricingEntry, now: number): PricingRates {
  const historical = entry.historicalRates
    ?.map((rates) => ({ rates, cutoff: Date.parse(rates.before) }))
    .filter(({ cutoff }) => Number.isFinite(cutoff) && now < cutoff)
    .sort((a, b) => a.cutoff - b.cutoff)[0]?.rates

  return historical ?? entry
}

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
  at: Date = new Date(),
):
  | {
      inputPerMtok: number
      outputPerMtok: number
      cacheCreationPerMtok?: number
      cacheCreation1hPerMtok?: number
      cacheReadPerMtok?: number
      speedMultipliers?: SpeedMultipliers
    }
  | undefined {
  const entry = PRICING[id]
  if (!entry) return undefined
  const rates = effectiveRates(entry, at.getTime())
  return {
    inputPerMtok: rates.input,
    outputPerMtok: rates.output,
    cacheCreationPerMtok: rates.cacheCreation,
    ...(rates.cacheCreation1h !== undefined
      ? { cacheCreation1hPerMtok: rates.cacheCreation1h }
      : {}),
    cacheReadPerMtok: rates.cacheRead,
    ...(entry.speedMultipliers ? { speedMultipliers: entry.speedMultipliers } : {}),
  }
}
