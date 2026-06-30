import { getSettings, type ApiKeySettings, type ApiKeyStatus } from '../config/settings'
import type { WebSearchOptions, WebSearchProviderId, WebSearchResponse } from './types'

/**
 * Host-side seam for a swappable web-search vendor. The credential plumbing
 * (settingsKeyField / envVarName / getApiKeyStatus / getEffectiveApiKey) is a verbatim
 * copy of BaseLlmProvider / BaseSttProvider — settings take precedence over env.
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
}
