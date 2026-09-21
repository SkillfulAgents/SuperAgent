import type { ModelDefinition, ModelCatalogSettings } from './model-catalog-schema'
import { canonicalPricingId, modelPricingCandidates } from './model-pricing-ids'
import { pricingFor, restatesBuiltinRate } from './model-pricing-lookup'
import {
  globalModelPricingSchema,
  globalModelPricingPatchSchema,
  type GlobalModelPricing,
  type GlobalModelPricingPatch,
  type ModelPricing,
} from './global-pricing-schema'

/**
 * The override that prices `model`, most specific key first: the exact id, then
 * its snapshot/version-stripped forms, then the bare model behind a prefix. So a
 * dated runtime id finds its custom model's price, and `azure/gpt-5.5` uses its
 * own price when it has one and the shared `gpt-5.5` price when it does not.
 */
export function findGlobalPrice(
  model: string,
  prices: GlobalModelPricing = {},
): ModelPricing | undefined {
  for (const id of modelPricingCandidates(model)) {
    if (Object.hasOwn(prices, id)) return prices[id]
  }
  return undefined
}

const CACHE_RATE_FIELDS = [
  'cacheCreationPerMtok',
  'cacheCreation1hPerMtok',
  'cacheReadPerMtok',
] as const

/**
 * The card shown for an overridden model. An override that only sets input and
 * output keeps the built-in card's cache ratios and speed multipliers, the same
 * rule usage accounting applies (`rateCardFromOverride`), so the catalog never
 * shows a different card from the one that is billed.
 */
function displayPricing(override: ModelPricing, builtin: ReturnType<typeof pricingFor>): ModelPricing {
  if (!builtin) return override
  const shown: ModelPricing = { ...override }
  for (const field of CACHE_RATE_FIELDS) {
    const rate = builtin[field]
    if (shown[field] !== undefined || rate === undefined || builtin.inputPerMtok <= 0) continue
    shown[field] = override.inputPerMtok * (rate / builtin.inputPerMtok)
  }
  if (!shown.speedMultipliers && builtin.speedMultipliers) {
    shown.speedMultipliers = builtin.speedMultipliers
  }
  return shown
}

export function patchGlobalModelPricing(
  current: GlobalModelPricing = {},
  patch: GlobalModelPricingPatch,
): GlobalModelPricing {
  const next = new Map(Object.entries(current))
  for (const [id, price] of Object.entries(globalModelPricingPatchSchema.parse(patch))) {
    const key = canonicalPricingId(id)
    if (price === null) next.delete(key)
    else next.set(key, price)
  }
  return globalModelPricingSchema.parse(Object.fromEntries(next))
}

export function withGlobalModelPricing(
  catalog: ModelDefinition[],
  prices: GlobalModelPricing = {},
): ModelDefinition[] {
  return catalog.map((model) => {
    const builtin = pricingFor(model.id)
    const override = findGlobalPrice(model.id, prices)
    return { ...model, pricing: override ? displayPricing(override, builtin) : builtin }
  })
}

/** One-time import and compatibility for older settings clients. When old
 * providers disagree, preserve the active provider first, then stable ID order.
 *
 * A legacy price that merely restates the built-in rate (the dialog saved
 * without a change) is dropped rather than imported: as a global override it
 * would flatten the model's historical schedule and shadow later rate-card
 * updates, which the per-provider code never let it do.
 */
export function extractCatalogPricing(catalogs: ModelCatalogSettings, active = 'anthropic') {
  const prices = new Map<string, NonNullable<ModelDefinition['pricing']>>()
  const catalog: ModelCatalogSettings = {}
  const providers = Object.keys(catalogs).sort((a, b) =>
    a === active ? -1 : b === active ? 1 : a.localeCompare(b),
  )
  for (const provider of providers) {
    catalog[provider] = {
      ...catalogs[provider],
      overrides: catalogs[provider].overrides.map((entry) => {
        const { pricing, ...model } = entry
        const key = canonicalPricingId(entry.id)
        const restated = !entry.longContextPriceCliff && pricing && restatesBuiltinRate(entry.id, pricing)
        if (pricing && !restated && !prices.has(key))
          prices.set(key, {
            ...pricing,
            ...(entry.longContextPriceCliff
              ? { longContextPriceCliff: entry.longContextPriceCliff }
              : {}),
          })
        return model
      }),
    }
  }
  return { catalog, pricing: globalModelPricingSchema.parse(Object.fromEntries(prices)) }
}
