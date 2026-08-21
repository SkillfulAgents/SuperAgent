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
} from './types'

/** Proxy status → user remedy. 401/403/402 must not share copy (proxy auth.ts, billing/gate.ts). */
const PROXY_REMEDIES: Record<number, string> = {
  401: 'your Gamut session has expired or is invalid. Sign in again, or pick a different provider under the Web provider setting in Settings.',
  403: 'your Gamut account does not have access to it (the trial may have ended, or the membership is inactive). Check your account, or pick a different provider under the Web provider setting in Settings.',
  402: 'your Gamut account has a billing issue. Resolve billing, or switch to Native or Exa under the Web provider setting in Settings.',
}

function mapPlatformWebError(err: unknown, surface: 'search' | 'fetch'): unknown {
  const remedy = err instanceof NonRetryableError && err.status ? PROXY_REMEDIES[err.status] : undefined
  if (!remedy) return err
  return new Error(`Platform web ${surface} is unavailable: ${remedy}`)
}

/** Gamut web vendor: Exa shape via platform proxy (Bearer). Credential is the platform login. */
export class PlatformWebProvider extends BaseWebProvider {
  readonly id: WebProviderId = 'platform'
  readonly name = 'Platform'

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
      return mapExaSearchResponse(await this.postToProxy('/v1/exa/search', token, body))
    } catch (err) {
      throw mapPlatformWebError(err, 'search')
    }
  }

  async fetch(url: string, opts: WebFetchOptions): Promise<WebFetchResult> {
    const token = this.requireToken('fetch')
    const body = buildExaContentsBody(url, this.clampMaxChars(opts.maxChars))
    try {
      const json = await this.postToProxy('/v1/exa/contents', token, body)
      return mapExaContentsResponse(json, new Date().toISOString())
    } catch (err) {
      throw mapPlatformWebError(err, 'fetch')
    }
  }

  async validateKey(): Promise<{ valid: boolean; error?: string }> {
    return { valid: false, error: 'Platform uses your Gamut login, not an API key.' }
  }
}
