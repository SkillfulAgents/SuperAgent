import type {
  CatalogOverrideEntry,
  ModelCatalogSettings,
  ModelDefinition,
  ModelSearchResult,
} from '@shared/lib/llm-provider'
import { modelDefinitionSchema } from '@shared/lib/llm-provider/model-catalog-schema'

/** Per-provider catalog overrides, or an empty list when none are stored. */
export function providerOverrides(
  modelCatalog: ModelCatalogSettings | undefined,
  providerId: string,
): CatalogOverrideEntry[] {
  return modelCatalog?.[providerId]?.overrides ?? []
}

/** True when an override carries nothing but its `id` (no real patch). */
export function isEmptyOverride(entry: CatalogOverrideEntry): boolean {
  return Object.entries(entry).every(([key, value]) => key === 'id' || value === undefined)
}

/** Strip undefined fields; returns null when only the `id` would remain. */
export function cleanOverride(entry: CatalogOverrideEntry): CatalogOverrideEntry | null {
  const cleaned = Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined),
  ) as CatalogOverrideEntry
  return isEmptyOverride(cleaned) ? null : cleaned
}

/** Replace (or remove, when `entry` is null) the override for `id`. */
export function replaceOverride(
  overrides: CatalogOverrideEntry[],
  entry: CatalogOverrideEntry | null,
  id: string,
): CatalogOverrideEntry[] {
  const rest = overrides.filter((override) => override.id !== id)
  return entry ? [...rest, entry] : rest
}

/** Write a provider's overrides back into the catalog settings map. */
export function setProviderOverrides(
  modelCatalog: ModelCatalogSettings | undefined,
  providerId: string,
  overrides: CatalogOverrideEntry[],
): ModelCatalogSettings {
  const next: ModelCatalogSettings = { ...(modelCatalog ?? {}) }
  if (overrides.length === 0) {
    delete next[providerId]
  } else {
    next[providerId] = { overrides }
  }
  return next
}

/** Parse an override into a full model definition, dropping the `disabled` flag. */
export function modelFromOverride(entry: CatalogOverrideEntry): ModelDefinition | null {
  const model = { ...entry }
  delete model.disabled
  const parsed = modelDefinitionSchema.safeParse(model)
  return parsed.success ? parsed.data : null
}

export interface ModelFamilyGroup {
  family: string
  models: ModelDefinition[]
}

/** Group models by `family` (preserving first-seen order); unfamilied → 'other'. */
export function groupModelsByFamily(models: ModelDefinition[]): ModelFamilyGroup[] {
  const order: string[] = []
  const byFamily = new Map<string, ModelDefinition[]>()
  for (const model of models) {
    const family = model.family ?? 'other'
    if (!byFamily.has(family)) {
      byFamily.set(family, [])
      order.push(family)
    }
    byFamily.get(family)!.push(model)
  }
  return order.map((family) => ({ family, models: byFamily.get(family)! }))
}

/** Compact in/out price label, e.g. `$2.5/$15/MTok`. */
export function priceLabel(pricing: ModelDefinition['pricing']): string {
  if (!pricing) return 'No pricing'
  return `$${pricing.inputPerMtok}/$${pricing.outputPerMtok}/MTok`
}

/** Human context-window label, e.g. 200000 → "200K context"; undefined when unset. */
export function formatTokenWindow(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M context`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K context`
  return `${tokens} context`
}

/** Yes/No image-input label, or undefined when support is unknown. */
export function imageInputLabel(supportsImageInput: boolean | undefined): string | undefined {
  if (supportsImageInput === undefined) return undefined
  return supportsImageInput ? 'Image input: Yes' : 'Image input: No'
}

/** Secondary line for a search result: context window · price · image input. */
export function searchResultMeta(model: ModelSearchResult): string {
  return [
    formatTokenWindow(model.contextWindow),
    model.pricing ? priceLabel(model.pricing) : undefined,
    imageInputLabel(model.supportsImageInput),
  ].filter(Boolean).join(' · ')
}

/** Parse a price input into a non-negative number, or undefined when blank/invalid. */
export function parseOptionalPrice(rawValue: string): number | undefined {
  if (rawValue.trim() === '') return undefined
  const value = Number(rawValue)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}
