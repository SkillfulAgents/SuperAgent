import { getSettings, type ApiKeySettings, type ApiKeyStatus } from '../config/settings'
import { NonRetryableError, withRetry } from '../utils/retry'
import type {
  WebFetchOptions,
  WebFetchResult,
  WebProviderId,
  WebSearchOptions,
  WebSearchResponse,
  WebVendorTier,
} from './types'

// Shared host limits for every web vendor (search + fetch). Vendors bill per request and native
// tools have implicit resilience that a vendor swap removes (§13), so all vendors get one retry on
// transient failures. The 15s timeout guards a hung connection (global fetch has none).
const REQUEST_TIMEOUT_MS = 15_000
const RETRY_ATTEMPTS = 2 // 1 retry
const RETRY_BASE_DELAY_MS = 500

// Shared result clamp (search): every vendor clamps to the same host cap (vendors bill per result).
const DEFAULT_NUM_RESULTS = 10
const MAX_NUM_RESULTS = 25

// Shared content bound (fetch): when the caller requests a content-length cap, clamp it into a sane
// range before handing it to the vendor (defense-in-depth; the host route also re-caps).
const MAX_FETCH_CHARS = 100_000

/**
 * Host-side base for a swappable web vendor. The credential plumbing
 * (settingsKeyField / envVarName / getApiKeyStatus / getEffectiveApiKey) is a verbatim copy of
 * BaseLlmProvider / BaseSttProvider — settings take precedence over env. The shared transport
 * (timeout + retry + status classification) and key validation live here too; a concrete vendor
 * only builds its request and maps its response.
 *
 * One provider class per vendor exposes both operations as optional methods (search / fetch),
 * mirroring BaseLlmProvider's one-class-per-vendor / per-purpose-method shape. A vendor implements
 * the side(s) it supports; method presence IS the capability — the MCP gate and each host route
 * probe `provider.search` / `provider.fetch`. Exa implements both.
 */
export abstract class BaseWebProvider {
  abstract readonly name: string
  abstract readonly id: WebProviderId
  /** What this vendor costs the user; the sole input to automatic precedence (see WebVendorTier). */
  abstract readonly tier: WebVendorTier
  protected abstract readonly settingsKeyField: keyof ApiKeySettings
  protected abstract readonly envVarName: string

  /** Run a ranked web search and return normalized hits. Throws on a whole-request failure. */
  search?(query: string, opts: WebSearchOptions): Promise<WebSearchResponse>

  /**
   * Fetch a single URL's full content and return one normalized document. Throws on a whole-request
   * failure (mirrors search's error model).
   */
  fetch?(url: string, opts: WebFetchOptions): Promise<WebFetchResult>

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

  /** Validate an API key. */
  abstract validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }>

  /**
   * Fetch a vendor endpoint under the shared timeout + retry policy and return the parsed JSON body
   * for the caller to validate with its Zod schema. Retries once on transient failures (429 / 5xx /
   * timeout); a 4xx config error is deterministic, so it throws NonRetryableError to bypass the
   * retry. The timeout is re-armed per attempt.
   */
  protected async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    return withRetry(
      async () => {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        if (!res.ok) {
          const message = `${this.name} request failed: ${res.status}`
          if (res.status === 429 || res.status >= 500) throw new Error(message)
          throw new NonRetryableError(message, res.status)
        }
        return res.json()
      },
      RETRY_ATTEMPTS,
      RETRY_BASE_DELAY_MS,
    )
  }

  /**
   * Run a key-validation request under the shared timeout and classify the outcome: ok → valid;
   * 401/403 → invalid key; other status → API error; thrown → network error. The caller's closure
   * issues the vendor request with the supplied abort signal.
   */
  protected async runValidation(
    doFetch: (signal: AbortSignal) => Promise<Response>,
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await doFetch(AbortSignal.timeout(REQUEST_TIMEOUT_MS))
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' }
      return { valid: false, error: `${this.name} API error: ${res.status}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { valid: false, error: `Network error: ${message}` }
    }
  }

  /** Clamp a requested search result count into [1, MAX_NUM_RESULTS], defaulting when unset. */
  protected clampNumResults(n?: number): number {
    if (n == null) return DEFAULT_NUM_RESULTS
    return Math.max(1, Math.min(n, MAX_NUM_RESULTS))
  }

  /** Clamp a requested fetch content-char bound into [1, MAX_FETCH_CHARS]; undefined stays undefined. */
  protected clampMaxChars(n?: number): number | undefined {
    if (n == null) return undefined
    return Math.max(1, Math.min(n, MAX_FETCH_CHARS))
  }
}
