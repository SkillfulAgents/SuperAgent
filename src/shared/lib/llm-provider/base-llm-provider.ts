import Anthropic from '@anthropic-ai/sdk'
import { getSettings, type ApiKeySettings, type ApiKeyStatus } from '../config/settings'

export type LlmProviderId = 'anthropic' | 'openrouter' | 'bedrock' | 'platform'

export interface ModelOption {
  value: string
  label: string
}

export type ModelPurpose = 'agent' | 'summarizer' | 'browser'

/** Three Claude families exposed in the per-message model selector. */
export const COMPOSER_MODEL_FAMILIES = ['opus', 'sonnet', 'haiku'] as const
export type ComposerModelFamily = typeof COMPOSER_MODEL_FAMILIES[number]

export interface ComposerModel {
  family: ComposerModelFamily
  modelId: string
  label: string
}

export abstract class BaseLlmProvider {
  abstract readonly id: LlmProviderId
  abstract readonly name: string

  /** Which field in ApiKeySettings stores this provider's key. */
  protected abstract readonly settingsKeyField: keyof ApiKeySettings
  /** Environment variable name for this provider's key. */
  protected abstract readonly envVarName: string

  /** Check whether an API key is configured and its source. */
  getApiKeyStatus(): ApiKeyStatus {
    const settings = getSettings()
    if (settings.apiKeys?.[this.settingsKeyField]) {
      return { isConfigured: true, source: 'settings' }
    }
    if (process.env[this.envVarName]) {
      return { isConfigured: true, source: 'env' }
    }
    return { isConfigured: false, source: 'none' }
  }

  /** Get the effective API key (settings take precedence over env var). */
  getEffectiveApiKey(): string | undefined {
    const settings = getSettings()
    const fromSettings = settings.apiKeys?.[this.settingsKeyField]
    if (fromSettings) return fromSettings
    return process.env[this.envVarName]
  }

  /** Create an Anthropic-compatible SDK client configured for this provider. */
  abstract createClient(): Anthropic

  /** Get the models available for this provider. */
  abstract getAvailableModels(): ModelOption[]

  /** Get the default model for a given purpose. */
  abstract getDefaultModel(purpose: ModelPurpose): string

  /**
   * Models surfaced in the composer's per-message family selector
   * (Haiku / Sonnet / Opus). One entry per family, resolved to the
   * provider's latest pinned model ID. Empty array hides the selector.
   */
  abstract getComposerModels(): ComposerModel[]

  /** Get env vars to inject into agent containers. */
  abstract getContainerEnvVars(): Record<string, string | undefined>

  /** Validate an API key. */
  abstract validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }>
}
