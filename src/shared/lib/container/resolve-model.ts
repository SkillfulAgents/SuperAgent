import {
  getActiveLlmProvider,
  getEffectiveCatalog,
  hasVersionSegment,
  resolveActiveProviderModel,
  type LlmProviderId,
  type ModelDefinition,
  type ModelPurpose,
} from '@shared/lib/llm-provider'

// Anthropic-native web tools the main agent invokes directly.
export const WEB_SEARCH_TOOLS: readonly string[] = ['WebSearch', 'WebFetch']

export interface ContainerModelRuntimeConfig {
  modelPromptHints: string[]
  unsupportedTools: string[]
}

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

function findCatalogModel(catalog: ModelDefinition[], selection: string): ModelDefinition | undefined {
  return (
    catalog.find(model => model.id === selection) ??
    catalog.find(model => model.family === selection && model.isLatest)
  )
}

function isLikelyClaudeModel(model: string): boolean {
  const normalized = model.toLowerCase()
  return normalized.includes('claude') || normalized.includes('anthropic')
}

function shouldDisableWebTools(
  providerId: LlmProviderId,
  resolvedModel: string,
  modelDefinition: ModelDefinition | undefined,
): boolean {
  if (modelDefinition?.supportsWebSearch === false) return true
  if (modelDefinition?.supportsWebSearch === true) return false
  if (modelDefinition) return false
  return providerId !== 'anthropic' && hasVersionSegment(resolvedModel) && !isLikelyClaudeModel(resolvedModel)
}

export function getContainerModelRuntimeConfig(
  resolvedModel: string | undefined,
  purpose: ModelPurpose = 'agent',
): ContainerModelRuntimeConfig {
  try {
    const provider = getActiveLlmProvider()
    const catalog = getEffectiveCatalog(provider.id)
    const fallback = provider.getDefaultModel(purpose)
    const selectedModel = resolvedModel ?? fallback
    const modelDefinition = findCatalogModel(catalog, selectedModel)
    const effectiveModel = modelDefinition?.id ?? selectedModel
    const unsupportedTools = shouldDisableWebTools(provider.id, effectiveModel, modelDefinition)
      ? [...WEB_SEARCH_TOOLS]
      : []

    return {
      modelPromptHints: modelDefinition?.promptHints ?? [],
      unsupportedTools,
    }
  } catch {
    return { modelPromptHints: [], unsupportedTools: [] }
  }
}
