import { CodexSubscriptionLlmProvider } from './codex-subscription-provider'
import { GrokSubscriptionLlmProvider } from './grok-subscription-provider'
import { KimiSubscriptionLlmProvider } from './kimi-subscription-provider'
import { MinimaxSubscriptionLlmProvider } from './minimax-subscription-provider'
export { BaseLlmProvider } from './base-llm-provider'
export { LLM_PROVIDER_IDS } from './provider-types'
export type { LlmProviderId } from './provider-types'
export type { ModelPurpose, ProviderDefaultModelOption } from './base-llm-provider'
export {
  defaultParseErrorResponse,
  errorPlacement,
  extractErrorMessage,
  inferErrorStatus,
} from './error-presentation'
export type {
  ProviderErrorPlacement,
  ProviderErrorPresentation,
  ProviderErrorSeverity,
} from './error-presentation'
export { AnthropicLlmProvider } from './anthropic-provider'
export { OpenRouterLlmProvider } from './openrouter-provider'
export { BedrockLlmProvider } from './bedrock-provider'
export { PlatformLlmProvider } from './platform-provider'
export { GenericLlmProvider } from './generic-provider'
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
  getModelContextWindowMap,
  getModelPromptHints,
  hasVersionSegment,
  resolveModelForProvider,
} from './model-catalog'

import type { LlmProviderId } from './provider-types'
import type { ModelPurpose, ProviderDefaultModelOption } from './base-llm-provider'
import { BaseLlmProvider, type ProviderConfiguration } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import { getEffectiveCatalog, getProviderCatalog, resolveModelForProvider } from './model-catalog'
import { AnthropicLlmProvider } from './anthropic-provider'
import { ClaudeSubscriptionLlmProvider } from './claude-subscription-provider'
import { OpenRouterLlmProvider } from './openrouter-provider'
import { BedrockLlmProvider } from './bedrock-provider'
import { PlatformLlmProvider } from './platform-provider'
import { GenericLlmProvider } from './generic-provider'
import { getSettings } from '../config/settings'

const providers: Record<LlmProviderId, BaseLlmProvider> = {
  anthropic: new AnthropicLlmProvider(),
  'claude-subscription': new ClaudeSubscriptionLlmProvider(),
  'codex-subscription': new CodexSubscriptionLlmProvider(),
  'grok-subscription': new GrokSubscriptionLlmProvider(),
  'kimi-subscription': new KimiSubscriptionLlmProvider(),
  'minimax-subscription': new MinimaxSubscriptionLlmProvider(),
  openrouter: new OpenRouterLlmProvider(),
  bedrock: new BedrockLlmProvider(),
  platform: new PlatformLlmProvider(),
  generic: new GenericLlmProvider(),
}

/** A fresh instance bound to one connection, without ambient credential fallback. */
export function createLlmProvider(id: LlmProviderId, configuration: ProviderConfiguration): BaseLlmProvider {
  switch (id) {
    case 'anthropic': return new AnthropicLlmProvider(configuration)
    case 'claude-subscription': return new ClaudeSubscriptionLlmProvider(configuration)
    case 'codex-subscription': return new CodexSubscriptionLlmProvider(configuration)
    case 'grok-subscription': return new GrokSubscriptionLlmProvider(configuration)
    case 'kimi-subscription': return new KimiSubscriptionLlmProvider(configuration)
    case 'minimax-subscription': return new MinimaxSubscriptionLlmProvider(configuration)
    case 'openrouter': return new OpenRouterLlmProvider(configuration)
    case 'bedrock': return new BedrockLlmProvider(configuration)
    case 'generic': return new GenericLlmProvider(configuration)
    case 'platform': return new PlatformLlmProvider()
  }
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
  /** Curated default-model choices and provider-specific onboarding copy. */
  defaultModelOptions: readonly ProviderDefaultModelOption[]
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
    defaultModelOptions: p.defaultModelOptions,
    capabilities: {
      modelSearch: p.supportsModelSearch,
    },
  }))
}
