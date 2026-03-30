export { BaseLlmProvider } from './base-llm-provider'
export type { LlmProviderId, ModelOption, ModelPurpose } from './base-llm-provider'
export { AnthropicLlmProvider } from './anthropic-provider'
export { OpenRouterLlmProvider } from './openrouter-provider'
export { BedrockLlmProvider } from './bedrock-provider'
export { PlatformLlmProvider } from './platform-provider'

import type { LlmProviderId } from './base-llm-provider'
import { BaseLlmProvider } from './base-llm-provider'
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

export interface LlmProviderInfo {
  id: LlmProviderId
  name: string
  isConfigured: boolean
  availableModels: { value: string; label: string }[]
}

/** Get info about all providers (for settings UI). */
export function getAllProviderInfo(): LlmProviderInfo[] {
  return Object.values(providers).map(p => ({
    id: p.id,
    name: p.name,
    isConfigured: p.getApiKeyStatus().isConfigured,
    availableModels: p.getAvailableModels(),
  }))
}
