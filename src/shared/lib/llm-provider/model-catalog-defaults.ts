import type { ModelCatalogSettings } from './model-catalog-schema'
import type { LlmProviderId } from './provider-types'

/** Per-purpose fallback selections owned by a provider's model catalog. */
export interface CatalogDefaultModels {
  summarizerModel: string
  agentModel: string
  browserModel: string
  dashboardBuilderModel: string
}

export const ANTHROPIC_CATALOG_DEFAULT_MODELS: CatalogDefaultModels = {
  summarizerModel: 'haiku',
  agentModel: 'opus',
  browserModel: 'sonnet',
  dashboardBuilderModel: 'opus',
}

export const OPENROUTER_CATALOG_DEFAULT_MODELS: CatalogDefaultModels = {
  summarizerModel: 'haiku',
  agentModel: 'sonnet',
  browserModel: 'sonnet',
  dashboardBuilderModel: 'opus',
}

export const BEDROCK_CATALOG_DEFAULT_MODELS: CatalogDefaultModels = {
  summarizerModel: 'haiku',
  agentModel: 'sonnet',
  browserModel: 'sonnet',
  dashboardBuilderModel: 'opus',
}

export const PLATFORM_CATALOG_DEFAULT_MODELS: CatalogDefaultModels = {
  summarizerModel: 'haiku',
  agentModel: 'grok',
  browserModel: 'sonnet',
  dashboardBuilderModel: 'opus',
}

export const GENERIC_FALLBACK_MODEL = 'default'
export const GENERIC_CATALOG_DEFAULT_MODELS: CatalogDefaultModels = {
  summarizerModel: GENERIC_FALLBACK_MODEL,
  agentModel: GENERIC_FALLBACK_MODEL,
  browserModel: GENERIC_FALLBACK_MODEL,
  dashboardBuilderModel: GENERIC_FALLBACK_MODEL,
}

const BUILTIN_DEFAULTS: Record<LlmProviderId, CatalogDefaultModels> = {
  anthropic: ANTHROPIC_CATALOG_DEFAULT_MODELS,
  openrouter: OPENROUTER_CATALOG_DEFAULT_MODELS,
  bedrock: BEDROCK_CATALOG_DEFAULT_MODELS,
  platform: PLATFORM_CATALOG_DEFAULT_MODELS,
  generic: GENERIC_CATALOG_DEFAULT_MODELS,
}

/**
 * Return provider/catalog-specific defaults without importing provider classes
 * (and therefore without creating a config ↔ provider runtime cycle).
 * Generic catalogs have no built-ins, so their first enabled custom entry is
 * the fallback for every purpose.
 */
export function getCatalogDefaultModels(
  providerId: LlmProviderId,
  modelCatalog?: ModelCatalogSettings,
): CatalogDefaultModels {
  if (providerId === 'generic') {
    const firstUserModel = (modelCatalog?.generic?.overrides ?? [])
      .find((entry) => entry.disabled !== true)?.id
    const genericDefault =
      firstUserModel || process.env.GENERIC_DEFAULT_MODEL?.trim() || GENERIC_FALLBACK_MODEL
    if (genericDefault !== GENERIC_FALLBACK_MODEL) {
      return {
        summarizerModel: genericDefault,
        agentModel: genericDefault,
        browserModel: genericDefault,
        dashboardBuilderModel: genericDefault,
      }
    }
  }
  // Settings files are deliberately tolerant of unknown keys/values. A newer
  // build may persist a provider id that an older build does not know after a
  // downgrade, so the runtime lookup must not assume the TypeScript union was
  // enforced on disk.
  return BUILTIN_DEFAULTS[providerId] ?? ANTHROPIC_CATALOG_DEFAULT_MODELS
}
