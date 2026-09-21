import MODEL_PRICING from '../services/model-pricing.json'
import { modelPricingCandidates } from './model-pricing-ids'

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

/** The static card for an id or any of its aliases. hasOwn: ids are arbitrary text. */
function staticEntry(id: string): PricingEntry | undefined {
  const key = modelPricingCandidates(id).find((candidate) => Object.hasOwn(PRICING, candidate))
  return key === undefined ? undefined : PRICING[key]
}

function effectiveRates(entry: PricingEntry, now: number): PricingRates {
  const historical = entry.historicalRates
    ?.map((rates) => ({ rates, cutoff: Date.parse(rates.before) }))
    .filter(({ cutoff }) => Number.isFinite(cutoff) && now < cutoff)
    .sort((a, b) => a.cutoff - b.cutoff)[0]?.rates

  return historical ?? entry
}

interface TokenRates {
  inputPerMtok: number
  outputPerMtok: number
  cacheCreationPerMtok?: number
  cacheCreation1hPerMtok?: number
  cacheReadPerMtok?: number
}

/**
 * True when `rates` restates a rate the built-in card has or had for `id`: every
 * field it sets equals the current card or one of its historical cards. Such a
 * price is not a user override, so importing it must not shadow the schedule.
 */
export function restatesBuiltinRate(id: string, rates: TokenRates): boolean {
  const entry = staticEntry(id)
  if (!entry) return false
  return [entry, ...(entry.historicalRates ?? [])].some(
    (card) =>
      rates.inputPerMtok === card.input &&
      rates.outputPerMtok === card.output &&
      (rates.cacheCreationPerMtok ?? card.cacheCreation) === card.cacheCreation &&
      (rates.cacheCreation1hPerMtok ?? card.cacheCreation1h) === card.cacheCreation1h &&
      (rates.cacheReadPerMtok ?? card.cacheRead) === card.cacheRead,
  )
}

/**
 * Display pricing for a catalog entry, seeded from model-pricing.json.
 * Provider-qualified and dated aliases resolve through the shared model IDs.
 * Returns undefined when the model has no known rate.
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
  const entry = staticEntry(id)
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
