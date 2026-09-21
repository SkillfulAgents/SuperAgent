import type { ModelDefinition, ModelCatalogSettings } from './model-catalog-schema'
import { canonicalPricingId } from './model-pricing-ids'
import { pricingFor } from './model-pricing-lookup'
import {
  globalModelPricingSchema,
  globalModelPricingPatchSchema,
  type GlobalModelPricing,
  type GlobalModelPricingPatch,
} from './global-pricing-schema'

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
  return catalog.map((model) => ({
    ...model,
    pricing: prices[canonicalPricingId(model.id)] ?? pricingFor(model.id),
  }))
}

/** One-time import and compatibility for older settings clients. When old
 * providers disagree, preserve the active provider first, then stable ID order.
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
        if (pricing && !prices.has(key))
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
