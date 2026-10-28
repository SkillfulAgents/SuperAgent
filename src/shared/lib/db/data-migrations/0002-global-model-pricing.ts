import type { DataMigration } from './index'

export const globalModelPricing: DataMigration = {
  id: 2,
  name: 'global-model-pricing',
  async run() {
    const { loadSettingsStrict, mutateSettings } = await import('../../config/settings')
    const { extractCatalogPricing } = await import('../../llm-provider/global-pricing')
    // Strict, not getSettings(): that one answers an unreadable file with
    // defaults, which would look like "nothing to move" and get this migration
    // recorded as done with the legacy prices still in the catalog.
    const settings = loadSettingsStrict()
    const legacy = settings.modelCatalog ?? {}
    // Nothing left to move: a fresh install, or a retry after the settings write.
    const hasLegacyPrices = Object.values(legacy).some((provider) =>
      provider.overrides.some((entry) => entry.pricing !== undefined),
    )
    if (!hasLegacyPrices) return
    const { catalog, pricing } = extractCatalogPricing(legacy, settings.llmProvider)
    mutateSettings((s) => {
      s.modelCatalog = catalog
      // Preserve a completed settings write when retrying before ledger commit.
      s.modelPricing = { ...pricing, ...s.modelPricing }
    })
  },
}
