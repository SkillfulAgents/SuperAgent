import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider, type AgentIdentity, type ProviderSettings } from './base-llm-provider'
import type { ApiKeyStatus } from '../config/settings'
import type { ConnectionConfig } from './connection-schema'
import { rewriteLoopbackForContainer } from './container-url'
import { OLLAMA_CATALOG_DEFAULT_MODELS } from './model-catalog-defaults'
import type { ModelDefinition } from './model-catalog-schema'
import { getOllamaStatus } from './ollama-client'
import { normalizeOllamaBaseUrl } from './ollama-schema'

// Ollama ignores credentials, but the SDK and the CLI refuse to start without one.
const PLACEHOLDER_TOKEN = 'ollama'

/**
 * A local Ollama server, spoken to over its native Anthropic Messages API. Its
 * catalog is whatever the server has installed, copied into the connection's
 * overrides by `ollama-catalog-sync.ts`: catalogs are local data, so a stopped
 * server never makes a model look deleted.
 */
export class OllamaLlmProvider extends BaseLlmProvider {
  readonly id = 'ollama' as const
  readonly name = 'Ollama'
  readonly defaultModelOptions = []
  readonly catalogDefaultModels = OLLAMA_CATALOG_DEFAULT_MODELS
  protected readonly settingsKeyField = undefined
  protected readonly envVarName = 'OLLAMA_API_KEY'

  /**
   * A connection needs no credential, but the unbound provider must not read as
   * set up: onboarding asks it whether the person has connected anything.
   */
  override apiKeyStatusFrom(_settings: ProviderSettings | undefined): ApiKeyStatus {
    return this.configuration ? { isConfigured: true, source: 'settings' } : { isConfigured: false, source: 'none' }
  }

  private get baseUrl(): string {
    return normalizeOllamaBaseUrl(this.configuration?.apiKeys.ollamaBaseUrl)
  }

  async createClientFrom(): Promise<Anthropic> {
    return new Anthropic({ baseURL: this.baseUrl, authToken: PLACEHOLDER_TOKEN })
  }

  getBuiltinCatalog(): ModelDefinition[] {
    return []
  }

  /** A saved address is always one the catalog sync and containers can use. */
  override normalizeConnectionConfig(config: ConnectionConfig): ConnectionConfig {
    return { ...config, apiKeys: { ...config.apiKeys, ollamaBaseUrl: normalizeOllamaBaseUrl(config.apiKeys.ollamaBaseUrl) } }
  }

  async getContainerEnvVars(_agent?: AgentIdentity): Promise<Record<string, string | undefined>> {
    return {
      ANTHROPIC_API_KEY: '',
      // Ollama on the host is not localhost from inside an agent container.
      ANTHROPIC_BASE_URL: rewriteLoopbackForContainer(this.baseUrl),
      ANTHROPIC_AUTH_TOKEN: PLACEHOLDER_TOKEN,
    }
  }

  async validateKey(_apiKey: string): Promise<{ valid: boolean; error?: string }> {
    const status = await getOllamaStatus(this.baseUrl)
    return status.state === 'running' ? { valid: true } : { valid: false, error: status.error }
  }
}
