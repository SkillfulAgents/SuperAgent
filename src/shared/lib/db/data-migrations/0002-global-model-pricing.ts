import type { DataMigration } from './index'
import { importLegacyRecords } from './0009-import-host-records'

export const globalModelPricing: DataMigration = {
  id: 2,
  name: 'global-model-pricing',
  async run(db) {
    const { loadSettingsStrict, mutateSettings } = await import('../../config/settings')
    const { extractCatalogPricing } = await import('../../llm-provider/global-pricing')
    // The settings on this migration's handle, legacy settings.json imported
    // first: an install that skips versions has its prices still in the file.
    await importLegacyRecords(db)
    // Strict, not getSettings(): that one answers invalid stored settings with
    // defaults, which would look like "nothing to move" and get this migration
    // recorded as done with the legacy prices still in the catalog.
    const settings = await loadSettingsStrict(db)
    const legacy = settings.modelCatalog ?? {}
    // Nothing left to move: a fresh install, or a retry after the settings write.
    const hasLegacyPrices = Object.values(legacy).some((provider) =>
      provider.overrides.some((entry) => entry.pricing !== undefined),
    )
    if (!hasLegacyPrices) return
    await mutateSettings((s) => {
      // Extracted from the settings this attempt read, so a retried write
      // moves what is stored now.
      const { catalog, pricing } = extractCatalogPricing(s.modelCatalog ?? {}, s.llmProvider)
      s.modelCatalog = catalog
      // Preserve a completed settings write when retrying before ledger commit.
      s.modelPricing = { ...pricing, ...s.modelPricing }
    }, db)
  },
}
