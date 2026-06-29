import {
  getActiveLlmProvider,
  getModelDefinition,
  getModelPromptHints,
  resolveActiveProviderModel,
  type ModelPurpose,
} from '@shared/lib/llm-provider'

/**
 * Anthropic-native web tools the agent invokes directly. Banned for a model
 * with `supportsWebSearch === false`.
 */
export const WEB_SEARCH_TOOLS: readonly string[] = ['WebSearch', 'WebFetch']

/**
 * Tools whose results carry image content blocks. Banned for a model with
 * `supportsImageInput === false`.
 *
 * This is the MAIN model's disallow list, so it only removes these from the
 * main agent's context. The browser/dashboard/computer subagents have their
 * own model + tool list and are unaffected, so dashboards/browsing keep working
 * on the subagents' (vision-capable) models.
 */
export const IMAGE_EMITTING_TOOLS: readonly string[] = [
  'mcp__browser__browser_screenshot',
  'mcp__browser__browser_get_state',
  'mcp__computer-use__computer_screenshot',
  'mcp__dashboards__start_dashboard',
]

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

/**
 * Tools the given (already-resolved) wire model can't use, based on the active
 * provider's catalog capabilities: web tools when web search is unsupported,
 * image-emitting tools when image input is unsupported. Empty for a model that
 * supports both or whose capabilities are unknown (assume supported).
 */
export function getContainerUnsupportedTools(resolvedModel: string | undefined): string[] {
  if (!resolvedModel) return []
  try {
    const def = getModelDefinition(resolvedModel, getActiveLlmProvider().id)
    if (!def) return []
    const tools: string[] = []
    if (def.supportsWebSearch === false) tools.push(...WEB_SEARCH_TOOLS)
    if (def.supportsImageInput === false) tools.push(...IMAGE_EMITTING_TOOLS)
    return tools
  } catch {
    // Same test-context fallback as getContainerModelPromptHints.
    return []
  }
}
