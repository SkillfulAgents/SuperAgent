import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider, type ModelPurpose } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import { getSettings, getModelCatalogSettings } from '../config/settings'

const BASE_URL_ENV = 'GENERIC_BASE_URL'
const DEFAULT_MODEL_ENV = 'GENERIC_DEFAULT_MODEL'

/**
 * Ultimate fallback model id when the user has added no models and set no
 * GENERIC_DEFAULT_MODEL. A placeholder — the generic provider is only usable
 * once the user adds at least one model via the catalog editor (SUP-276).
 */
export const GENERIC_FALLBACK_MODEL = 'default'

/**
 * A user-pointed provider for any Anthropic-wire-compatible endpoint: a
 * self-hosted gateway, a LiteLLM/proxy in Anthropic mode, or a localhost ollama
 * fronted by such a proxy. Ships an EMPTY built-in catalog — users add their
 * own models (SUP-276) — and takes a user-supplied baseURL + key.
 *
 * Wire format: Anthropic (same env shape as OpenRouter/Platform —
 * ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN). ollama's native OpenAI-compatible
 * API is NOT spoken directly; point at an Anthropic-compatible proxy.
 */
export class GenericLlmProvider extends BaseLlmProvider {
  readonly id = 'generic' as const
  readonly name = 'Generic'
  protected readonly settingsKeyField = 'genericApiKey' as const
  protected readonly envVarName = 'GENERIC_API_KEY'

  /** User-supplied endpoint, from settings (preferred) or GENERIC_BASE_URL env. */
  getEffectiveBaseUrl(): string | undefined {
    const fromSettings = getSettings().apiKeys?.genericBaseUrl?.trim()
    if (fromSettings) return fromSettings
    const fromEnv = process.env[BASE_URL_ENV]?.trim()
    return fromEnv || undefined
  }

  createClient(): Anthropic {
    const baseURL = this.getEffectiveBaseUrl()
    if (!baseURL) throw new Error('Generic provider base URL not configured')
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Generic provider API key not configured')
    // Anthropic-wire endpoint with Bearer auth (same shape as OpenRouter/Platform):
    // apiKey '' suppresses the x-api-key header; authToken sends Authorization: Bearer.
    return new Anthropic({ apiKey: '', baseURL, authToken: apiKey })
  }

  getBuiltinCatalog(): ModelDefinition[] {
    // Empty by design — users add their models via the catalog editor (SUP-276).
    return []
  }

  getDefaultModel(_purpose: ModelPurpose): string {
    // No built-in catalog: default to the first user-added model, then an
    // env-configurable default, then a placeholder the user overrides.
    const firstUserModel = (getModelCatalogSettings()[this.id]?.overrides ?? [])
      .find((entry) => entry.disabled !== true)?.id
    if (firstUserModel) return firstUserModel
    return process.env[DEFAULT_MODEL_ENV]?.trim() || GENERIC_FALLBACK_MODEL
  }

  getContainerEnvVars(): Record<string, string | undefined> {
    // A 'localhost' endpoint (e.g. ollama on the host) isn't reachable as
    // localhost from inside the agent container; rewrite to the host gateway
    // (same translation the platform provider applies).
    const containerUrl = this.getEffectiveBaseUrl()?.replace('://localhost', '://host.docker.internal')
    return {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: containerUrl,
      ANTHROPIC_AUTH_TOKEN: this.getEffectiveApiKey(),
    }
  }

  async validateKey(
    apiKey: string,
    opts?: { baseUrl?: string },
  ): Promise<{ valid: boolean; error?: string }> {
    // baseURL may not be saved yet during first-time setup, so accept it inline.
    const baseURL = opts?.baseUrl?.trim() || this.getEffectiveBaseUrl()
    if (!baseURL) return { valid: false, error: 'Base URL is required' }
    try {
      const client = new Anthropic({ apiKey: '', baseURL, authToken: apiKey })
      await client.messages.create({
        model: this.getDefaultModel('summarizer'),
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }],
      })
      return { valid: true }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Validation failed' }
    }
  }
}
