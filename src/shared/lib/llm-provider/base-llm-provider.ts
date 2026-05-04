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
   * (Haiku / Sonnet / Opus). The wire format is the family alias because
   * the agent container's toModelAlias() collapses every pinned or
   * region-prefixed ID to the alias before the SDK call — so all providers
   * we support today (Anthropic, OpenRouter, Platform, Bedrock) share the
   * same three options. Override only if a provider needs different
   * families or wants to hide the selector by returning [].
   * See agent-container/src/claude-code.ts:263.
   */
  getComposerModels(): ComposerModel[] {
    return [
      { family: 'opus', modelId: 'opus', label: 'Opus 4.7' },
      { family: 'sonnet', modelId: 'sonnet', label: 'Sonnet 4.6' },
      { family: 'haiku', modelId: 'haiku', label: 'Haiku 4.5' },
    ]
  }

  /** Get env vars to inject into agent containers. */
  abstract getContainerEnvVars(): Record<string, string | undefined>

  /** Validate an API key. */
  abstract validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }>
}
