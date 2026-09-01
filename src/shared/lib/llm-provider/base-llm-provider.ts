import Anthropic from '@anthropic-ai/sdk'
import { getSettings, type ApiKeySettings, type ApiKeyStatus } from '../config/settings'
import type { ModelDefinition, ModelSearchResult } from './model-catalog-schema'
import type { CatalogDefaultModels } from './model-catalog-defaults'
import type { LlmProviderId } from './provider-types'
import { defaultParseErrorResponse, type ProviderErrorPresentation } from './error-presentation'

export { LLM_PROVIDER_IDS } from './provider-types'
export type { LlmProviderId } from './provider-types'

export type ModelPurpose = 'agent' | 'summarizer' | 'browser' | 'dashboard'

/**
 * A curated default-model choice shown during onboarding. The selection may be
 * a bare family alias (so it rides catalog upgrades) or a concrete model id.
 * Keeping this on the provider lets each provider offer a different shortlist
 * and provider-specific copy while the renderer remains catalog-agnostic.
 */
export interface ProviderDefaultModelOption {
  model: string
  /** Stable fallback label, also used when the option names a model family. */
  label: string
  /** Display the currently resolved catalog entry's label when available. */
  resolveLabelFromCatalog?: boolean
  tag: string
  description: string
  subdescription?: string
}

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
  abstract readonly defaultModelOptions: readonly ProviderDefaultModelOption[]
  abstract readonly catalogDefaultModels: CatalogDefaultModels

  /** Which field in ApiKeySettings stores this provider's key. */
  protected abstract readonly settingsKeyField: keyof ApiKeySettings
  /** Environment variable name for this provider's key. */
  protected abstract readonly envVarName: string
  /** Whether this provider can discover remote catalog models by search query. */
  readonly supportsModelSearch: boolean = false

  /**
   * Value of `ENABLE_TOOL_SEARCH` for containers on this provider, or
   * undefined to leave the variable unset so the CLI decides for itself.
   *
   * Tool search omits tool definitions from the request and loads them back on
   * demand, which the endpoint has to expand: the CLI re-sends a loaded tool
   * with `defer_loading: true`, and since agent SDK 0.3.219 it also sends a
   * `DeferredToolPlaceholder` tool carrying that flag on EVERY request.
   * Endpoints that don't understand the flag reject the whole request
   * (OpenRouter 400s it for every non-Anthropic model), so only providers whose
   * endpoint handles it turn this on. Left unset, the CLI disables tool search
   * for any base URL that isn't a first-party Anthropic host — the right
   * default for endpoints we can't vouch for.
   */
  readonly toolSearchEnv: 'true' | undefined = undefined

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
   * an `isLatest` flag marking what a bare family alias resolves to, and an
   * `isDefault` flag marking the picker default for each model vendor.
   * See ./model-catalog.ts for how a stored selection resolves against this.
   */
  abstract getBuiltinCatalog(): ModelDefinition[]

  /**
   * Get the default model for a given purpose, as a bare family alias
   * (e.g. 'opus') so defaults ride upgrades. The resolver alias-resolves
   * this to a concrete id; it is the ultimate fallback when a selection
   * can't be matched.
   */
  getDefaultModel(purpose: ModelPurpose): string {
    switch (purpose) {
      case 'summarizer': return this.catalogDefaultModels.summarizerModel
      case 'agent': return this.catalogDefaultModels.agentModel
      case 'browser': return this.catalogDefaultModels.browserModel
      case 'dashboard': return this.catalogDefaultModels.dashboardBuilderModel
    }
  }

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

  /** Get env vars to inject into agent containers. */
  abstract getContainerEnvVars(agent?: AgentIdentity): Record<string, string | undefined>

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

  /**
   * Banner presentation for an upstream HTTP error. Providers customize copy by
   * overriding parseErrorResponseOverride, not this method.
   */
  parseErrorResponse(status: number | undefined, body: unknown): ProviderErrorPresentation {
    return this.parseErrorResponseOverride(status, body) ?? defaultParseErrorResponse(status, body)
  }

  /**
   * Provider-specific presentation for the error classes this provider
   * recognizes. Return null for everything else — the generic banner is
   * applied here in the base class, so overrides never build it themselves.
   */
  protected parseErrorResponseOverride(
    _status: number | undefined,
    _body: unknown,
  ): ProviderErrorPresentation | null {
    return null
  }
}
