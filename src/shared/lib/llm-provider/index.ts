export { BaseLlmProvider } from './base-llm-provider'
export type { LlmProviderId, ModelPurpose } from './base-llm-provider'
export { AnthropicLlmProvider } from './anthropic-provider'
export { OpenRouterLlmProvider } from './openrouter-provider'
export { BedrockLlmProvider } from './bedrock-provider'
export { PlatformLlmProvider } from './platform-provider'
export {
  modelDefinitionSchema,
  modelCatalogSchema,
  catalogOverrideEntrySchema,
  providerCatalogOverridesSchema,
  modelCatalogSettingsSchema,
  modelSearchResultSchema,
} from './model-catalog-schema'
export type {
  ModelDefinition,
  ModelSearchResult,
  CatalogOverrideEntry,
  ProviderCatalogOverrides,
  ModelCatalogSettings,
} from './model-catalog-schema'
export {
  getEffectiveCatalog,
  getProviderCatalog,
  getModelDefinition,
  getModelContextWindow,
  getModelPromptHints,
  hasVersionSegment,
  resolveModelForProvider,
} from './model-catalog'

import type { LlmProviderId, ModelPurpose } from './base-llm-provider'
import { BaseLlmProvider } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import { getEffectiveCatalog, getProviderCatalog, resolveModelForProvider } from './model-catalog'
import { AnthropicLlmProvider } from './anthropic-provider'
import { OpenRouterLlmProvider } from './openrouter-provider'
import { BedrockLlmProvider } from './bedrock-provider'
import { PlatformLlmProvider } from './platform-provider'
import { getSettings } from '../config/settings'

const providers: Record<LlmProviderId, BaseLlmProvider> = {
  anthropic: new AnthropicLlmProvider(),
  openrouter: new OpenRouterLlmProvider(),
  bedrock: new BedrockLlmProvider(),
  platform: new PlatformLlmProvider(),
}

/** Get a specific provider by ID. */
export function getLlmProvider(id: LlmProviderId): BaseLlmProvider {
  const provider = providers[id]
  if (!provider) throw new Error(`Unknown LLM provider: ${id}`)
  return provider
}

/** Get the active (user-selected) LLM provider. */
export function getActiveLlmProvider(): BaseLlmProvider {
  const settings = getSettings()
  const id = (settings.llmProvider ?? 'anthropic') as LlmProviderId
  return getLlmProvider(id)
}

/**
 * Resolve a stored selection (bare alias or concrete id) to the concrete wire
 * id for the ACTIVE provider. Use at host-direct SDK call sites (e.g. the
 * summarizer) that don't pass through the container client's chokepoint.
 */
export function resolveActiveProviderModel(selection: string, purpose: ModelPurpose): string {
  return resolveModelForProvider(selection, getActiveLlmProvider().id, purpose)
}

/** Default model selection per purpose, as bare family aliases (ride upgrades). */
export interface ProviderDefaultModels {
  agent: string
  summarizer: string
  browser: string
}

export interface LlmProviderInfo {
  id: LlmProviderId
  name: string
  isConfigured: boolean
  /** Concrete model ids this provider offers after user overrides. */
  catalog: ModelDefinition[]
  /** Built-in provider catalog, before user disables, patches, or custom entries. */
  builtinCatalog?: ModelDefinition[]
  /** Per-purpose default selections (bare aliases). */
  defaultModels: ProviderDefaultModels
  capabilities: {
    modelSearch: boolean
  }
}

function defaultModelsFor(provider: BaseLlmProvider): ProviderDefaultModels {
  return {
    agent: provider.getDefaultModel('agent'),
    summarizer: provider.getDefaultModel('summarizer'),
    browser: provider.getDefaultModel('browser'),
  }
}

/** Get info about all providers (for settings UI). */
export function getAllProviderInfo(): LlmProviderInfo[] {
  return Object.values(providers).map(p => ({
    id: p.id,
    name: p.name,
    isConfigured: p.getApiKeyStatus().isConfigured,
    catalog: getEffectiveCatalog(p.id),
    builtinCatalog: getProviderCatalog(p.id),
    defaultModels: defaultModelsFor(p),
    capabilities: {
      modelSearch: p.supportsModelSearch,
    },
  }))
}
