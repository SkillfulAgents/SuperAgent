import { getSettings, type ApiKeySettings, type ApiKeyStatus } from '../config/settings'
import { NonRetryableError, withRetry } from '../utils/retry'
import type { WebSearchOptions, WebSearchProviderId, WebSearchResponse } from './types'

// Shared host limits + retry policy. Every vendor clamps results to the same host cap (vendors bill
// per result) and gets one retry on transient failures — native search has implicit resilience that
// a vendor swap removes (§13). The 15s timeout guards a hung connection (global fetch has none).
const DEFAULT_NUM_RESULTS = 10
const MAX_NUM_RESULTS = 25
const REQUEST_TIMEOUT_MS = 15_000
const RETRY_ATTEMPTS = 2 // 1 retry
const RETRY_BASE_DELAY_MS = 500

/**
 * Host-side seam for a swappable web-search vendor. The credential plumbing
 * (settingsKeyField / envVarName / getApiKeyStatus / getEffectiveApiKey) is a verbatim
 * copy of BaseLlmProvider / BaseSttProvider — settings take precedence over env. The shared
 * transport (timeout + retry + status classification) and result clamp live here too; a vendor
 * only builds its request and maps its response.
 *
 * When the fetch seam (BaseWebFetchProvider) lands it shares this exact plumbing; that
 * is the second occurrence at which to extract a shared BaseWebProvider both extend.
 */
export abstract class BaseWebSearchProvider {
  abstract readonly id: WebSearchProviderId
  abstract readonly name: string
  protected abstract readonly settingsKeyField: keyof ApiKeySettings
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

  /** Run a ranked web search and return normalized hits. Throws on a whole-request failure. */
  abstract search(query: string, opts: WebSearchOptions): Promise<WebSearchResponse>

  /** Validate an API key. */
  abstract validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }>

  /** Clamp a requested result count into [1, MAX_NUM_RESULTS], defaulting when unset. */
  protected clampNumResults(n?: number): number {
    if (n == null) return DEFAULT_NUM_RESULTS
    return Math.max(1, Math.min(n, MAX_NUM_RESULTS))
  }

  /**
   * Fetch a vendor search endpoint under the shared timeout + retry policy and return the parsed
   * JSON body for the caller to validate with its Zod schema. Retries once on transient failures
   * (429 / 5xx / timeout); a 4xx config error is deterministic, so it throws NonRetryableError to
   * bypass the retry. The timeout is re-armed per attempt.
   */
  protected async fetchSearchJson(url: string, init: RequestInit): Promise<unknown> {
    return withRetry(
      async () => {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        if (!res.ok) {
          const message = `${this.name} search failed: ${res.status}`
          if (res.status === 429 || res.status >= 500) throw new Error(message)
          throw new NonRetryableError(message)
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
}
