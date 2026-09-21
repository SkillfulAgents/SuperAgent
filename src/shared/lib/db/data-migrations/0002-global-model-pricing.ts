import type { DataMigration } from './index'

export const globalModelPricing: DataMigration = {
  id: 2,
  name: 'global-model-pricing',
  async run() {
    const { getSettings, mutateSettings } = await import('../../config/settings')
    const { extractCatalogPricing } = await import('../../llm-provider/global-pricing')
    const settings = getSettings()
    const { catalog, pricing } = extractCatalogPricing(
      settings.modelCatalog ?? {},
      settings.llmProvider,
    )
    if (!Object.keys(pricing).length) return
    mutateSettings((s) => {
      s.modelCatalog = catalog
      // Preserve a completed settings write when retrying before ledger commit.
      s.modelPricing = { ...pricing, ...s.modelPricing }
    })
  },
}
