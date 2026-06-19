import type { LlmProviderId, ModelPurpose } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import { getLlmProvider } from './index'

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
 * Normalize a raw built-in catalog so each family has at most one `isLatest`
 * entry (keep the first, clear the rest). A safety net — built-ins are
 * authored with exactly one latest per family, but user catalogs (SUP-276)
 * may not be.
 */
function normalizeCatalog(catalog: ModelDefinition[]): ModelDefinition[] {
  const seenLatestFamilies = new Set<string>()
  return catalog.map(model => {
    if (model.isLatest && model.family) {
      if (seenLatestFamilies.has(model.family)) {
        return { ...model, isLatest: false }
      }
      seenLatestFamilies.add(model.family)
    }
    return model
  })
}

/** A provider's built-in catalog, normalized to ≤1 isLatest per family. */
export function getProviderCatalog(providerId: LlmProviderId): ModelDefinition[] {
  return normalizeCatalog(getLlmProvider(providerId).getBuiltinCatalog())
}

/** Look up a concrete model definition by id within a provider's catalog. */
export function getModelDefinition(
  id: string,
  providerId: LlmProviderId,
): ModelDefinition | undefined {
  return getProviderCatalog(providerId).find(model => model.id === id)
}

/** Static catalog context-window for a model, or undefined if unset. */
export function getModelContextWindow(
  id: string,
  providerId: LlmProviderId,
): number | undefined {
  return getModelDefinition(id, providerId)?.contextWindow
}

/** Static catalog prompt hints for a model, or an empty list if unset. */
export function getModelPromptHints(
  id: string,
  providerId: LlmProviderId,
): string[] {
  return getModelDefinition(id, providerId)?.promptHints ?? []
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
 * resolves to 'us.anthropic.claude-sonnet-4-6', never reaching the SDK bare.
 */
export function resolveModelForProvider(
  selection: string,
  providerId: LlmProviderId,
  purpose: ModelPurpose,
): string {
  const catalog = getProviderCatalog(providerId)

  // exact concrete id (pin/passthrough), else bare family alias → its isLatest id
  const resolveExactOrAlias = (s: string): string | undefined => {
    if (catalog.some(model => model.id === s)) return s
    return catalog.find(model => model.family === s && model.isLatest)?.id
  }

  // 1 & 2.
  const direct = resolveExactOrAlias(selection)
  if (direct) return direct

  // 3. Unknown but versioned — treat as a pin and pass it straight to the SDK.
  if (hasVersionSegment(selection)) return selection

  // 4. Fall back to the provider default (a bare alias), alias-resolved to a concrete id.
  const fallback = getLlmProvider(providerId).getDefaultModel(purpose)
  return resolveExactOrAlias(fallback) ?? fallback
}
