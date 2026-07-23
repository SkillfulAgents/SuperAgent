import Anthropic from '@anthropic-ai/sdk'
import { getSettings, type ApiKeySettings, type ApiKeyStatus } from '../config/settings'
import type { ModelDefinition, ModelSearchResult } from './model-catalog-schema'

export type LlmProviderId = 'anthropic' | 'openrouter' | 'bedrock' | 'platform' | 'generic'

export type ModelPurpose = 'agent' | 'summarizer' | 'browser' | 'dashboard'

/**
 * Identity of the agent a container belongs to, resolved at env-build time.
 * Providers that attribute usage per agent (the platform proxy) fold it into
 * the container env; others ignore it.
 */
export interface AgentIdentity {
  /** The agent's unique id (folder slug, minted [a-z0-9]). */
  id: string
  /** Display name from frontmatter; free text, may be missing on parse failure. */
  name?: string
}

export abstract class BaseLlmProvider {
  abstract readonly id: LlmProviderId
  abstract readonly name: string

  /** Which field in ApiKeySettings stores this provider's key. */
  protected abstract readonly settingsKeyField: keyof ApiKeySettings
  /** Environment variable name for this provider's key. */
  protected abstract readonly envVarName: string
  /** Whether this provider can discover remote catalog models by search query. */
  readonly supportsModelSearch: boolean = false

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

  /**
   * The provider's built-in catalog of concrete model ids (shipped in code).
   * Each entry is a wire-ready model id with display metadata, family grouping,
   * and an `isLatest` flag marking what a bare family alias resolves to.
   * See ./model-catalog.ts for how a stored selection resolves against this.
   */
  abstract getBuiltinCatalog(): ModelDefinition[]

  /**
   * Get the default model for a given purpose, as a bare family alias
   * (e.g. 'opus') so defaults ride upgrades. The resolver alias-resolves
   * this to a concrete id; it is the ultimate fallback when a selection
   * can't be matched.
   */
  abstract getDefaultModel(purpose: ModelPurpose): string

  /**
   * All three per-purpose defaults as bare aliases, keyed to match the
   * `models` block of settings. Used to reset model selections when the
   * active provider changes, so a pin from the previous provider's catalog
   * (which may not exist for the new one, e.g. a bare-Claude id on Bedrock)
   * can't leak across providers.
   */
  getDefaultModels(): {
    summarizerModel: string
    agentModel: string
    browserModel: string
    dashboardBuilderModel: string
  } {
    return {
      summarizerModel: this.getDefaultModel('summarizer'),
      agentModel: this.getDefaultModel('agent'),
      browserModel: this.getDefaultModel('browser'),
      dashboardBuilderModel: this.getDefaultModel('dashboard'),
    }
  }

  /**
   * Get env vars to inject into agent containers.
   * `hostAddress` is the container-reachable host name/IP the active runtime
   * supplies (gateway IP on Apple; `host.docker.internal` elsewhere). When
   * omitted, loopback rewrites keep the Docker-convention default.
   */
  abstract getContainerEnvVars(
    agent?: AgentIdentity,
    hostAddress?: string,
  ): Record<string, string | undefined>

  /**
   * Validate an API key. `opts.baseUrl` is only meaningful for providers whose
   * endpoint is user-supplied (the generic provider); others ignore it.
   */
  abstract validateKey(
    apiKey: string,
    opts?: { baseUrl?: string },
  ): Promise<{ valid: boolean; error?: string }>

  /**
   * Search provider-native model catalogs and return normalized local-catalog
   * entries. Providers that do not opt in via supportsModelSearch should leave
   * the default implementation untouched.
   */
  async searchModels(_query: string): Promise<ModelSearchResult[]> {
    throw new Error(`${this.name} does not support model search`)
  }
}
