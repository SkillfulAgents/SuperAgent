export interface FlatModelPricing {
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
}

export type ModelPricingEntry = FlatModelPricing & Record<string, unknown>
export type ModelPricingTable = Record<string, ModelPricingEntry>

interface CuratedRatioCheck {
  path: string
  basePath: string
  rate: number
  priorBaseRate: number
  refreshedBaseRate: number
}

const TIER_FIELDS = ['marginalLongContext', 'longContext'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectCuratedRatioChecks(
  prior: ModelPricingEntry,
  refreshed: FlatModelPricing,
): CuratedRatioCheck[] {
  const checks: CuratedRatioCheck[] = []

  if (typeof prior.cacheCreation1h === 'number') {
    checks.push({
      path: 'cacheCreation1h',
      basePath: 'input',
      rate: prior.cacheCreation1h,
      priorBaseRate: prior.input,
      refreshedBaseRate: refreshed.input,
    })
  }

  for (const tierField of TIER_FIELDS) {
    const tier = prior[tierField]
    if (!isRecord(tier)) continue

    for (const rateField of ['input', 'output', 'cacheCreation', 'cacheRead'] as const) {
      const rate = tier[rateField]
      if (typeof rate === 'number') {
        checks.push({
          path: `${tierField}.${rateField}`,
          basePath: rateField,
          rate,
          priorBaseRate: prior[rateField],
          refreshedBaseRate: refreshed[rateField],
        })
      }
    }

    const oneHourRate = tier.cacheCreation1h
    if (typeof oneHourRate === 'number') {
      const explicitOneHourBase = prior.cacheCreation1h
      checks.push({
        path: `${tierField}.cacheCreation1h`,
        basePath:
          typeof explicitOneHourBase === 'number'
            ? 'cacheCreation1h'
            : 'impliedCacheCreation1h',
        rate: oneHourRate,
        priorBaseRate:
          typeof explicitOneHourBase === 'number' ? explicitOneHourBase : prior.input * 2,
        // The refresh has no one-hour field. An explicit curated base is
        // preserved; otherwise accounting derives the one-hour base as 2x input.
        refreshedBaseRate:
          typeof explicitOneHourBase === 'number' ? explicitOneHourBase : refreshed.input * 2,
      })
    }
  }

  return checks
}

function formatNumber(value: number): string {
  return Number(value.toFixed(6)).toString()
}

/**
 * Flag preserved absolute rates that may need a curator's attention after
 * their corresponding fetched base rate changes. The merge deliberately
 * leaves these fields untouched; this warning prevents that safe preservation
 * from silently changing an intended multiplier.
 */
export function getPricingRefreshDriftWarnings(
  existing: ModelPricingTable,
  refreshed: Record<string, FlatModelPricing>,
): string[] {
  const warnings: string[] = []

  for (const [id, flatRates] of Object.entries(refreshed)) {
    const prior = existing[id]
    if (!prior) continue

    const driftedRates = collectCuratedRatioChecks(prior, flatRates)
      .map(({ path, basePath, rate, priorBaseRate, refreshedBaseRate }) => ({
        path,
        basePath,
        rate,
        priorRatio: rate / priorBaseRate,
        refreshedRatio: rate / refreshedBaseRate,
      }))
      .filter(
        ({ rate, priorRatio, refreshedRatio }) =>
          Number.isFinite(rate) &&
          Number.isFinite(priorRatio) &&
          Number.isFinite(refreshedRatio) &&
          Math.abs(priorRatio - refreshedRatio) > 1e-12,
      )

    if (driftedRates.length === 0) continue

    const details = driftedRates
      .map(
        ({ path, basePath, priorRatio, refreshedRatio }) =>
          `${path}/${basePath} ${formatNumber(priorRatio)}x -> ${formatNumber(refreshedRatio)}x`,
      )
      .join('; ')
    warnings.push(
      `[pricing-refresh] ${id}: preserved curated pricing ratios drifted after refresh: ${details}. Review before committing model-pricing.json.`,
    )
  }

  return warnings
}

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
