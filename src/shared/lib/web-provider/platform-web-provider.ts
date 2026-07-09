import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getPlatformAccessToken } from '@shared/lib/services/platform-auth-service'
import type { ApiKeySettings, ApiKeyStatus } from '../config/settings'
import { NonRetryableError } from '../utils/retry'
import { BaseWebProvider } from './base-web-provider'
import {
  buildExaContentsBody,
  buildExaSearchBody,
  mapExaContentsResponse,
  mapExaSearchResponse,
} from './exa-web-provider'
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
 * Map a proxy error from a platform web call to an actionable, remediation-pointing message.
 * The provider pre-guards an ABSENT token, so at this point a token was sent and the proxy rejected
 * it. Each status carries a DIFFERENT remedy, and telling a user to do the wrong one is worse than
 * saying nothing, so they do not share copy (proxy: apps/proxy/src/auth.ts, billing/gate.ts):
 *
 *   401 — token expired / invalid / revoked / superseded  -> signing in again fixes it
 *   403 — trial ended / member inactive / wrong org        -> signing in again does NOT fix it
 *   402 — blocked / past due / insufficient balance        -> billing fixes it
 *
 * Each message names where to fix it (the Web provider setting), since a failed search/fetch is the
 * user's only touchpoint. Any other error passes through unchanged.
 */
export function mapPlatformWebError(err: unknown, surface: 'search' | 'fetch'): unknown {
  if (err instanceof NonRetryableError) {
    if (err.status === 401) {
      return new Error(
        `Platform web ${surface} is unavailable: your Gamut session has expired or is invalid. Sign in again, or pick a different provider under the Web provider setting in Settings.`,
      )
    }
    if (err.status === 403) {
      return new Error(
        `Platform web ${surface} is unavailable: your Gamut account does not have access to it (the trial may have ended, or the membership is inactive). Check your account, or pick a different provider under the Web provider setting in Settings.`,
      )
    }
    if (err.status === 402) {
      return new Error(
        `Platform web ${surface} is unavailable: your Gamut account has a billing issue. Resolve billing, or switch to Native or Exa under the Web provider setting in Settings.`,
      )
    }
  }
  return err
}

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
    const body = buildExaSearchBody(query, opts, this.clampNumResults(opts.numResults))
    try {
      return mapExaSearchResponse(await this.postToProxy(PROXY_SEARCH_PATH, token, body))
    } catch (err) {
      throw mapPlatformWebError(err, 'search')
    }
  }

  async fetch(url: string, opts: WebFetchOptions): Promise<WebFetchResult> {
    const token = this.requireToken('fetch')
    const body = buildExaContentsBody(url, this.clampMaxChars(opts.maxChars))
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
