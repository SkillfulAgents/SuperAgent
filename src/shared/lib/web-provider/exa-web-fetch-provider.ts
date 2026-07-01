import type { ApiKeySettings } from '../config/settings'
import { BaseWebFetchProvider } from './base-web-fetch-provider'
import { ExaContentsResponseSchema } from './exa-contents-response-schema'
import type { WebFetchOptions, WebFetchProviderId, WebFetchResult } from './types'

const EXA_CONTENTS_URL = 'https://api.exa.ai/contents'

/**
 * Map a raw Exa POST /contents response into a normalized WebFetchResult.
 * Parses at the boundary (Zod) then maps explicitly, so there are no `as`-casts. `fetchedAt` is
 * stamped host-side by the caller (no vendor returns it) and passed in so the map stays pure.
 * With `filterEmptyResults:false` (sent below) a failed URL stays in results[] with no text, which
 * maps to empty content — only a genuinely empty results[] is a whole-request failure.
 */
export function mapExaContentsResponse(raw: unknown, fetchedAt: string): WebFetchResult {
  const parsed = ExaContentsResponseSchema.parse(raw)
  const first = parsed.results[0]
  if (!first) throw new Error('Exa returned no content for the requested URL')
  return {
    url: first.url,
    title: first.title,
    content: first.text ?? '',
    ...(first.publishedDate ? { publishedDate: first.publishedDate } : {}),
    fetchedAt,
  }
}

export class ExaWebFetchProvider extends BaseWebFetchProvider {
  readonly id: WebFetchProviderId = 'exa'
  readonly name = 'Exa'
  protected readonly settingsKeyField: keyof ApiKeySettings = 'exaApiKey'
  protected readonly envVarName = 'EXA_API_KEY'

  async fetch(url: string, opts: WebFetchOptions): Promise<WebFetchResult> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Exa API key not configured')

    const maxChars = this.clampMaxChars(opts.maxChars)
    const body = JSON.stringify({
      urls: [url],
      // A bare `true` returns full text; a cap object bounds it when the caller asked for maxChars.
      text: maxChars != null ? { maxCharacters: maxChars } : true,
      // ALWAYS false: Exa defaults this to true, which silently DROPS a failed/empty URL from
      // results[] and breaks one-doc-per-URL mapping (§15). false keeps it so we map empty content.
      filterEmptyResults: false,
    })

    const json = await this.fetchJson(EXA_CONTENTS_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body,
    })
    return mapExaContentsResponse(json, new Date().toISOString())
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    return this.runValidation((signal) =>
      fetch(EXA_CONTENTS_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ urls: ['https://exa.ai'], text: true, filterEmptyResults: false }),
        signal,
      }),
    )
  }
}
