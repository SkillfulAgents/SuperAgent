import type { ProviderUsage } from './usage-schema'
import type { LlmProxyConfig } from '../../../../agent-container/src/llm-proxy-schema'
import type { OAuthCredential } from './oauth-schema'
import Anthropic from '@anthropic-ai/sdk'
import { getSettings, type ApiKeySettings, type ApiKeyStatus, type AppSettings } from '../config/settings'
import type { ConnectionConfig } from './connection-schema'
import type { ModelCatalogSettings, ModelDefinition, ModelSearchResult } from './model-catalog-schema'
import type { ModelAvailability } from './model-availability-schema'
import type { CatalogDefaultModels } from './model-catalog-defaults'
import type { LlmProviderId } from './provider-types'
import type { Attribution } from '../platform-attribution'
import { defaultParseErrorResponse, type ProviderErrorPresentation } from './error-presentation'
import { PROVIDER_ERROR_CODES, isUpstreamApiErrorCode } from '@shared/lib/types/api'

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

export interface ProviderConfiguration {
  apiFormat?: ConnectionConfig['apiFormat']
  chatTokenLimitField?: ConnectionConfig['chatTokenLimitField']
  oauth?: OAuthCredential
  resolveCredential?: (rejectedGeneration?: number) => Promise<OAuthCredential & { generation: number }>
  runtimeEnv?: Record<string, string>
  apiKeys: ApiKeySettings & ConnectionConfig['apiKeys']
  env: Record<string, string | undefined>
}

/**
 * The global settings a provider without a {@link ProviderConfiguration}
 * reads its credentials from (the platform provider: its stored connection).
 */
export type ProviderSettings = Pick<AppSettings, 'apiKeys' | 'platformAuth'>

/** How {@link BaseLlmProvider.getModelAvailability} reads what it needs. */
export interface ModelAvailabilityOptions {
  /** Re-read the provider's source instead of its cache. */
  fresh?: boolean
  /** The global settings the operation already read; read here when absent. */
  settings?: ProviderSettings
  /**
   * The attribution the operation acts under, resolved at most once for it by
   * the caller (see `actingAttributionOnce`); resolved here when absent.
   */
  acting?: () => Promise<Attribution | null>
}

export abstract class BaseLlmProvider {
  constructor(protected readonly configuration?: ProviderConfiguration) {}

  /**
   * The global settings for a provider that is not bound to a connection:
   * those the operation already read (`given`), else read fresh. Undefined
   * for one that is bound: it never reads global settings.
   */
  protected async ambientSettings(given?: ProviderSettings): Promise<ProviderSettings | undefined> {
    return this.configuration ? undefined : given ?? await getSettings()
  }

  /**
   * The connection's credentials, else those in the global settings given
   * (read with {@link ambientSettings}, once per operation).
   */
  protected keysFrom(settings: ProviderSettings | undefined): ProviderConfiguration['apiKeys'] {
    return this.configuration?.apiKeys ?? settings?.apiKeys ?? {}
  }

  protected envValue(name: string): string | undefined {
    return this.configuration ? this.configuration.runtimeEnv?.[name] ?? this.configuration.env[name] : process.env[name]
  }

  abstract readonly id: LlmProviderId
  abstract readonly name: string
  abstract readonly defaultModelOptions: readonly ProviderDefaultModelOption[]
  abstract readonly catalogDefaultModels: CatalogDefaultModels

  /** Which field in the provider credentials stores this provider's key. */
  protected abstract readonly settingsKeyField: keyof ProviderConfiguration['apiKeys'] | undefined
  /** Environment variable name for this provider's key. */
  protected abstract readonly envVarName: string
  /** Whether this provider can discover remote catalog models by search query. */
  readonly supportsModelSearch: boolean = false

  /** Whether this provider supports host-side Messages API calls (including summaries). */
  readonly supportsDirectApi: boolean = true

  readonly supportsUsage: boolean = false

  /** Whether model availability may need a provider-backed policy request. */
  readonly supportsModelAvailability: boolean = false

  /** Read-only allowance snapshot; never gates inference or model selection. */
  async getUsage(): Promise<ProviderUsage> {
    return { status: 'unsupported', observedAt: new Date().toISOString(), limits: [] }
  }

  /**
   * Value of `ENABLE_TOOL_SEARCH` for a session on `model` (the provider-wide
   * value when no model is given, as for the container-level env).
   *
   * Tool search omits tool definitions from the request and loads them back on
   * demand, which the endpoint has to expand: the CLI re-sends a loaded tool
   * with `defer_loading: true`, and since agent SDK 0.3.219 it also sends a
   * `DeferredToolPlaceholder` tool carrying that flag on EVERY request.
   * Endpoints that don't understand the flag reject the request (OpenRouter
   * 400s it for every non-Anthropic model). Keeping tool definitions out of
   * every request is a large share of a session's input tokens, so every
   * endpoint that expands deferred tools must say 'true'.
   *
   * Every provider answers explicitly: since CLI 2.1.304 an unset variable
   * means ON behind any custom base URL (a 400/422 is then retried without
   * deferred tools), where it used to mean off for anything but
   * api.anthropic.com.
   */
  async toolSearchEnv(_model?: string): Promise<'true' | 'false'> {
    return 'false'
  }

  /** Media-generation instructions for the agent, added only to sessions using this provider. */
  readonly mediaPrompt: string | undefined = undefined

  /** Check whether an API key is configured and its source. */
  async getApiKeyStatus(): Promise<ApiKeyStatus> {
    return this.apiKeyStatusFrom(await this.ambientSettings())
  }

  /**
   * {@link getApiKeyStatus} from global settings already read; a provider
   * bound to a connection ignores them. For callers that must not read the
   * settings again, such as a data migration reading its own handle.
   */
  apiKeyStatusFrom(settings: ProviderSettings | undefined): ApiKeyStatus {
    const keys = this.keysFrom(settings)
    if ((this.settingsKeyField ? keys[this.settingsKeyField] : undefined)) {
      return { isConfigured: true, source: 'settings' }
    }
    if (this.envValue(this.envVarName)) {
      return { isConfigured: true, source: 'env' }
    }
    return { isConfigured: false, source: 'none' }
  }

  /** Get the effective API key (settings take precedence over env var). */
  async getEffectiveApiKey(): Promise<string | undefined> {
    return this.effectiveApiKeyFrom(await this.ambientSettings())
  }

  /** {@link getEffectiveApiKey} from global settings already read. */
  protected effectiveApiKeyFrom(settings: ProviderSettings | undefined): string | undefined {
    const keys = this.keysFrom(settings)
    const fromSettings = (this.settingsKeyField ? keys[this.settingsKeyField] : undefined)
    if (fromSettings) return fromSettings
    return this.envValue(this.envVarName)
  }

  /** Create an Anthropic-compatible SDK client configured for this provider. */
  createClient(): Promise<Anthropic> {
    return this.createClientFrom()
  }

  /**
   * {@link createClient} from the global settings the operation already read
   * (read here when absent); a provider bound to a connection ignores them.
   */
  abstract createClientFrom(settings?: ProviderSettings): Promise<Anthropic>

  /**
   * The provider's built-in catalog of concrete model ids (shipped in code).
   * Each entry is a wire-ready model id with display metadata, family grouping,
   * an `isLatest` flag marking what a bare family alias resolves to, and an
   * `isDefault` flag marking the picker default for each model vendor.
   * See ./model-catalog.ts for how a stored selection resolves against this.
   */
  abstract getBuiltinCatalog(): ModelDefinition[]

  /**
   * Current restrictions for a connection's catalog, for the account the
   * current request or run is attributed to. Null means unrestricted. Model
   * selection treats an unavailable model like an unset one. `fresh` re-reads
   * the provider's source instead of its cache; `settings` and `acting` are
   * what the operation already read, so a chain of checks reads them once.
   */
  async getModelAvailability(_catalog: ModelDefinition[], _options: ModelAvailabilityOptions = {}): Promise<ModelAvailability | null> {
    return null
  }

  /** A live turn failed with this error; a provider may drop state it proves stale. */
  noteTurnError(_status: number | undefined, _body: unknown): void {}

  /**
   * Public cache identity for availability; changes when provider account
   * context changes. `settings`: the global settings already read, if any.
   */
  async getModelAvailabilityRevision(_settings?: ProviderSettings): Promise<string | null> {
    return null
  }

  /**
   * Get the default model for a given purpose, as a bare family alias
   * (e.g. 'opus') so defaults ride upgrades. The resolver alias-resolves
   * this to a concrete id; it is the ultimate fallback when a selection
   * can't be matched.
   *
   * `modelCatalog` is the global settings' catalog, for the one provider whose
   * defaults come from it (generic: the first model the user added). Without
   * it that provider falls back to GENERIC_DEFAULT_MODEL or its placeholder.
   */
  getDefaultModel(purpose: ModelPurpose, _modelCatalog?: ModelCatalogSettings): string {
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
  getDefaultModels(modelCatalog?: ModelCatalogSettings): {
    summarizerModel: string
    agentModel: string
    browserModel: string
    dashboardBuilderModel: string
  } {
    return {
      summarizerModel: this.getDefaultModel('summarizer', modelCatalog),
      agentModel: this.getDefaultModel('agent', modelCatalog),
      browserModel: this.getDefaultModel('browser', modelCatalog),
      dashboardBuilderModel: this.getDefaultModel('dashboard', modelCatalog),
    }
  }

  async getContainerProxyConfig(): Promise<LlmProxyConfig | undefined> { return undefined }

  /**
   * Get env vars to inject into agent containers. `settings`: the global
   * settings the operation already read (read here when absent and needed).
   */
  abstract getContainerEnvVars(agent?: AgentIdentity, settings?: ProviderSettings): Promise<Record<string, string | undefined>>

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

  // Presentation for a failed turn, or null when it is not a provider error.
  // Only consulted for upstream API failures: classes this provider recognizes
  // get one under any upstream code (the CLI tags some denials `unknown`);
  // the generic banner only under a code that marks a provider error.
  // `settings`: the global settings already read, so a page of errors reads
  // them once (the platform provider's billing link comes from them).
  async presentationForTurnError(
    status: number | undefined,
    body: unknown,
    apiErrorCode: string | null | undefined,
    settings?: ProviderSettings,
  ): Promise<ProviderErrorPresentation | null> {
    if (!isUpstreamApiErrorCode(apiErrorCode)) return null
    const specialized = await this.parseErrorResponseOverride(status, body, apiErrorCode, settings)
    if (specialized) return specialized
    return PROVIDER_ERROR_CODES.has(apiErrorCode) ? defaultParseErrorResponse(status, body) : null
  }

  /**
   * Provider-specific presentation for the error classes this provider
   * recognizes. Return null for everything else — the generic banner is
   * applied here in the base class, so overrides never build it themselves.
   */
  protected async parseErrorResponseOverride(
    _status: number | undefined,
    _body: unknown,
    _apiErrorCode?: string,
    _settings?: ProviderSettings,
  ): Promise<ProviderErrorPresentation | null> {
    return null
  }
}
