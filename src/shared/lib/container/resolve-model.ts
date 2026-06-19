import {
  getActiveLlmProvider,
  getModelPromptHints,
  resolveActiveProviderModel,
  type ModelPurpose,
} from '@shared/lib/llm-provider'

/**
 * Resolve a stored model selection (bare family alias or concrete id) to the
 * concrete wire id for the active provider, just before it enters a container
 * payload. This is the host-side chokepoint: callers store raw selections, the
 * container receives a resolved id, and the agent container no longer aliases.
 *
 * Returns undefined for an undefined selection (caller omits the field).
 */
export function resolveContainerModel(
  selection: string | undefined,
  purpose: ModelPurpose,
): string | undefined {
  if (!selection) return undefined
  try {
    return resolveActiveProviderModel(selection, purpose)
  } catch {
    // Resolution depends on loadable settings + provider registry. In test
    // contexts that partially mock the settings module those may be absent;
    // fall back to the raw selection (the SDK still accepts bare aliases).
    return selection
  }
}

/**
 * Catalog prompt hints for an already-resolved wire model id (the value
 * resolveContainerModel produced), looked up in the active provider's catalog.
 * Empty for Claude/unknown models.
 */
export function getContainerModelPromptHints(resolvedModel: string | undefined): string[] {
  if (!resolvedModel) return []
  try {
    return getModelPromptHints(resolvedModel, getActiveLlmProvider().id)
  } catch {
    // Same test-context fallback as resolveContainerModel: settings/provider
    // registry may be unmocked, in which case there are no hints to apply.
    return []
  }
}
