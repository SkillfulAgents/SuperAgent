import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import type { ApiKeySettings, ApiKeyStatus } from '../config/settings'
import { BaseWebProvider } from './base-web-provider'
import { mapExaContentsResponse, mapExaSearchResponse } from './exa-web-provider'
import { mapPlatformWebError } from './platform-web-error'
import type {
  WebFetchOptions,
  WebFetchResult,
  WebProviderId,
  WebSearchOptions,
  WebSearchResponse,
  WebVendorTier,
} from './types'

const PROXY_SEARCH_PATH = '/v1/exa/search'
const PROXY_CONTENTS_PATH = '/v1/exa/contents'

/**
 * The Gamut-provided web vendor. Same Exa request/response shape as ExaWebProvider, but routed
 * through the platform proxy on the shared Gamut key: a Bearer platform token instead of a per-user
 * x-api-key. The proxy is a transparent passthrough, so both responses parse with the same Exa
 * schemas and reuse Exa's mappers.
 *
 * The credential is the platform login, not a stored key, so getApiKeyStatus/getEffectiveApiKey are
 * overridden inline exactly as PlatformLlmProvider does it.
 */
export class PlatformWebProvider extends BaseWebProvider {
  readonly id: WebProviderId = 'platform'
  readonly name = 'Platform'
  readonly tier: WebVendorTier = 'included' // covered by the user's Gamut plan; costs them nothing

  // Not used — both credential methods are overridden to read the platform token.
  protected readonly settingsKeyField: keyof ApiKeySettings = 'exaApiKey'
  protected readonly envVarName = 'PLATFORM_TOKEN'

  override getApiKeyStatus(): ApiKeyStatus {
    if (getPlatformAccessToken()) return { isConfigured: true, source: 'settings' }
    if (process.env[this.envVarName]) return { isConfigured: true, source: 'env' }
    return { isConfigured: false, source: 'none' }
  }

  override getEffectiveApiKey(): string | undefined {
    return getPlatformAccessToken() ?? process.env[this.envVarName] ?? undefined
  }

  /** The Bearer token, or a sign-in error naming where to fix it (an absent token never hits the proxy). */
  private requireToken(surface: 'search' | 'fetch'): string {
    const token = this.getEffectiveApiKey()
    if (!token) {
      throw new Error(
        `Platform web ${surface} is unavailable: you are not signed into Gamut. Sign in, or pick a different provider under the Web provider setting in Settings.`,
      )
    }
    return token
  }

  private async postToProxy(path: string, token: string, body: string): Promise<unknown> {
    return this.fetchJson(`${getPlatformProxyBaseUrl()}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    })
  }

  async search(query: string, opts: WebSearchOptions): Promise<WebSearchResponse> {
    const token = this.requireToken('search')
    const body = JSON.stringify({
      query,
      numResults: this.clampNumResults(opts.numResults),
      includeDomains: opts.includeDomains,
      excludeDomains: opts.excludeDomains,
      startPublishedDate: opts.startPublishedDate,
      endPublishedDate: opts.endPublishedDate,
      contents: { highlights: true, text: { maxCharacters: 800 } },
    })
    try {
      return mapExaSearchResponse(await this.postToProxy(PROXY_SEARCH_PATH, token, body))
    } catch (err) {
      throw mapPlatformWebError(err, 'search')
    }
  }

  async fetch(url: string, opts: WebFetchOptions): Promise<WebFetchResult> {
    const token = this.requireToken('fetch')
    const maxChars = this.clampMaxChars(opts.maxChars)
    const body = JSON.stringify({
      urls: [url],
      text: maxChars != null ? { maxCharacters: maxChars } : true,
      // ALWAYS false, as in ExaWebProvider: Exa's default drops a failed URL from results[].
      filterEmptyResults: false,
    })
    try {
      const json = await this.postToProxy(PROXY_CONTENTS_PATH, token, body)
      return mapExaContentsResponse(json, new Date().toISOString())
    } catch (err) {
      throw mapPlatformWebError(err, 'fetch')
    }
  }

  // Platform is login-based, not key-based: /validate-web-key rejects 'platform' before this runs,
  // so there is nothing to validate. Return the login message rather than fire a live, billable
  // proxy probe from an otherwise-unreachable path.
  async validateKey(): Promise<{ valid: boolean; error?: string }> {
    return { valid: false, error: 'Platform uses your Gamut login, not an API key.' }
  }
}
