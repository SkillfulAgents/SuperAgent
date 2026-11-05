import { withGlobalModelPricing } from './global-pricing'
import { normalizeCatalog, mergeCatalog } from './catalog-merge'
import type { LlmProviderId, ModelPurpose } from './base-llm-provider'
import {
  isFamilyAlias,
  type ModelDefinition,
} from './model-catalog-schema'
import { getLlmProvider } from './index'
import { getSettings, type AppSettings } from '../config/settings'

/** The global settings a provider's effective catalog is built from. */
export type CatalogSettings = Pick<AppSettings, 'modelCatalog' | 'modelPricing'>

/**
 * Host-side source of truth for which concrete models a provider offers and
 * how a stored selection string resolves to a wire model id.
 *
 * A stored selection is a single string; its SHAPE decides resolution, so
 * there is no token format and no migration:
 *   - bare family alias ('opus')            → that family's isLatest id
 *   - concrete versioned id ('claude-opus-4-8') → pinned exactly
 */

/** True when a string carries a version segment (a hyphen followed by a digit). */
export function hasVersionSegment(s: string): boolean {
  return /-\d/.test(s)
}

/**
 * Normalize a catalog so each family has at most one `isLatest` entry. When
 * multiple entries claim latest for a family, keep the last one in catalog
 * order. Built-ins are authored oldest→newest within a family, and SUP-276
 * custom entries are appended after built-ins, so this lets a custom model
 * deliberately become the family alias target.
 */
export function getProviderCatalog(providerId: LlmProviderId): ModelDefinition[] {
  return normalizeCatalog(getLlmProvider(providerId).getBuiltinCatalog())
}

export async function getEffectiveCatalog(providerId: LlmProviderId): Promise<ModelDefinition[]> {
  return effectiveCatalogFrom(providerId, await getSettings())
}

/** {@link getEffectiveCatalog} from global settings already read. */
export function effectiveCatalogFrom(providerId: LlmProviderId, settings: CatalogSettings): ModelDefinition[] {
  return withGlobalModelPricing(mergeCatalog(getProviderCatalog(providerId), settings.modelCatalog?.[providerId]?.overrides ?? []), settings.modelPricing)
}

/** Look up a concrete model definition by id within a provider's catalog. */
export async function getModelDefinition(
  id: string,
  providerId: LlmProviderId,
): Promise<ModelDefinition | undefined> {
  return (await getEffectiveCatalog(providerId)).find(model => model.id === id)
}

/** Static catalog context-window for a model, or undefined if unset. */
export async function getModelContextWindow(
  id: string,
  providerId: LlmProviderId,
): Promise<number | undefined> {
  return (await getModelDefinition(id, providerId))?.contextWindow
}

/**
 * Model id → catalog context window for every entry that declares one.
 * Sent to the agent container so the Claude Agent SDK can be told the real
 * window for non-Claude models (it otherwise assumes a 200k default).
 */
export function getModelContextWindowMap(
  catalog: readonly ModelDefinition[],
): Record<string, number> {
  return Object.fromEntries(
    catalog
      .filter(model => model.contextWindow !== undefined)
      .map(model => [model.id, model.contextWindow as number]),
  )
}

/** Static catalog prompt hints for a model, or an empty list if unset. */
export async function getModelPromptHints(
  id: string,
  providerId: LlmProviderId,
): Promise<string[]> {
  return (await getModelDefinition(id, providerId))?.promptHints ?? []
}

/**
 * Resolve a stored selection to the concrete wire id for `providerId`.
 * Never throws.
 *
 *   1. exact id in catalog          → selection                        (version pin / passthrough)
 *   2. selection is a family alias  → that family's isLatest id         (tracks upgrades)
 *   3. unknown + has version segment → selection                        (treat as a pin, pass to SDK)
 *   4. otherwise                    → provider.getDefaultModel(purpose) (ultimate fallback)
 *
 * Provider defaults are themselves bare family aliases (so they ride upgrades),
 * so step 4 alias-resolves the default too — e.g. Bedrock's 'sonnet' default
 * resolves to 'us.anthropic.claude-sonnet-5', never reaching the SDK bare.
 */
export async function resolveModelForProvider(
  selection: string,
  providerId: LlmProviderId,
  purpose: ModelPurpose,
): Promise<string> {
  return resolveModelForProviderFrom(selection, providerId, purpose, await getSettings())
}

/** {@link resolveModelForProvider} from global settings already read. */
export function resolveModelForProviderFrom(
  selection: string,
  providerId: LlmProviderId,
  purpose: ModelPurpose,
  settings: CatalogSettings,
): string {
  const catalog = effectiveCatalogFrom(providerId, settings)

  // exact concrete id (pin/passthrough), else bare family alias → its isLatest id
  const resolveExactOrAlias = (s: string): string | undefined => {
    if (catalog.some(model => model.id === s)) return s
    return catalog.find(model => model.isLatest && isFamilyAlias(model, s))?.id
  }

  // 1 & 2.
  const direct = resolveExactOrAlias(selection)
  if (direct) return direct

  // 3. Unknown but versioned — treat as a pin and pass it straight to the SDK.
  if (hasVersionSegment(selection)) return selection

  // 4. Fall back to the provider default (a bare alias), alias-resolved to a concrete id.
  const fallback = getLlmProvider(providerId).getDefaultModel(purpose, settings.modelCatalog)
  return resolveExactOrAlias(fallback) ?? fallback
}
