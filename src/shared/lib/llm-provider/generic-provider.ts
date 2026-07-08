import Anthropic from '@anthropic-ai/sdk'
import { BaseLlmProvider, type ModelPurpose } from './base-llm-provider'
import type { ModelDefinition, ModelSearchResult } from './model-catalog-schema'
import type { EffortLevel } from '../container/types'
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
const DISCOVERED_MODEL_LIMIT = 50
const DISCOVERED_MODEL_EFFORTS: EffortLevel[] = ['low', 'medium', 'high']
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Fetch `<baseURL>/v1/models` with Bearer auth and a hard timeout. Returns
 * the raw Response for the caller to interpret. Both Anthropic's `/v1/models`
 * and OpenAI-compat endpoints (ollama, LiteLLM) speak this shape.
 */
async function fetchModelsList(baseURL: string, apiKey: string): Promise<Response> {
  const url = `${baseURL.replace(/\/+$/, '')}/v1/models`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

interface RemoteModelListing {
  id?: unknown
  /** OpenAI/ollama: undefined. Anthropic /v1/models: human display name. */
  display_name?: unknown
  /** OpenAI/ollama shape: 'model' | 'list'. Anthropic: often absent. */
  object?: unknown
}

interface RemoteModelsResponse {
  data?: unknown
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function mapRemoteModel(model: RemoteModelListing): ModelSearchResult | null {
  const id = stringValue(model.id)
  if (!id) return null
  const label = stringValue(model.display_name) ?? id
  return {
    id,
    label,
    supportedEfforts: DISCOVERED_MODEL_EFFORTS,
    // Non-Claude endpoints don't route Anthropic's native web-search tool;
    // omit rather than promise a capability we can't verify.
    supportsWebSearch: false,
  }
}

export class GenericLlmProvider extends BaseLlmProvider {
  readonly id = 'generic' as const
  readonly name = 'Generic'
  override readonly supportsModelSearch = true
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

  /**
   * Validate credentials by probing `<baseURL>/v1/models` — the same endpoint
   * search uses, so if validation passes, search works too. This avoids the
   * chicken-and-egg problem of needing a real model id before any have been
   * added: 200 means auth + connectivity both work, 401/403 pinpoints an auth
   * failure, and a 404 is treated as a soft-warn (endpoint reachable but
   * doesn't expose /v1/models — the user can still add models manually).
   */
  async validateKey(
    apiKey: string,
    opts?: { baseUrl?: string },
  ): Promise<{ valid: boolean; error?: string }> {
    // baseURL may not be saved yet during first-time setup, so accept it inline.
    const baseURL = opts?.baseUrl?.trim() || this.getEffectiveBaseUrl()
    if (!baseURL) return { valid: false, error: 'Base URL is required' }
    let response: Response
    try {
      response = await fetchModelsList(baseURL, apiKey)
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError'
        ? `Timed out after ${REQUEST_TIMEOUT_MS / 1000}s — check the base URL is reachable.`
        : `Could not reach ${baseURL}: ${error instanceof Error ? error.message : String(error)}`
      return { valid: false, error: message }
    }
    if (response.ok) return { valid: true }
    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: `Auth rejected (${response.status}) — check the API key.` }
    }
    if (response.status === 404) {
      // Reachable but no /v1/models — key not verifiable this way. Allow save so
      // the user can proceed to add models manually.
      return { valid: true }
    }
    return { valid: false, error: `Endpoint returned ${response.status}` }
  }

  /**
   * List models by hitting `<baseURL>/v1/models` (Bearer auth). Both
   * Anthropic's `/v1/models` and OpenAI-compatible endpoints (ollama, LiteLLM)
   * return `{data: [{id, ...}]}`, so one permissive mapper covers both. The
   * query filters the returned ids/labels client-side — neither endpoint
   * accepts a search parameter the way OpenRouter does.
   */
  override async searchModels(query: string): Promise<ModelSearchResult[]> {
    const baseURL = this.getEffectiveBaseUrl()
    if (!baseURL) throw new Error('Generic provider base URL not configured')
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Generic provider API key not configured')

    let response: Response
    try {
      response = await fetchModelsList(baseURL, apiKey)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Generic provider model listing timed out after ${REQUEST_TIMEOUT_MS / 1000}s`)
      }
      throw new Error(
        `Generic provider model listing failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(
          `Generic provider endpoint does not support model listing (404 at ${baseURL.replace(/\/+$/, '')}/v1/models)`,
        )
      }
      throw new Error(`Generic provider model listing failed (${response.status})`)
    }

    let body: RemoteModelsResponse
    try {
      body = (await response.json()) as RemoteModelsResponse
    } catch (error) {
      throw new Error(
        `Generic provider returned a non-JSON response: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const data = Array.isArray(body.data) ? body.data : []
    const mapped = data
      .map((entry) => mapRemoteModel(entry as RemoteModelListing))
      .filter((entry): entry is ModelSearchResult => entry !== null)

    const q = query.trim().toLowerCase()
    const filtered = q
      ? mapped.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
      : mapped
    return filtered.slice(0, DISCOVERED_MODEL_LIMIT)
  }
}
