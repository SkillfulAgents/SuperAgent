import type { ApiKeySettings } from '../config/settings'
import { BaseWebSearchProvider } from './base-web-search-provider'
import { ExaSearchResponseSchema } from './exa-response-schema'
import type { WebSearchOptions, WebSearchProviderId, WebSearchResponse } from './types'

const EXA_SEARCH_URL = 'https://api.exa.ai/search'

/**
 * Map a raw Exa POST /search response into the normalized WebSearchResponse.
 * Parses at the boundary (Zod) then maps explicitly, so there are no `as`-casts.
 * Snippet is normalized from Exa's `highlights` (short relevant excerpts), falling
 * back to `text` and finally an empty string.
 */
export function mapExaSearchResponse(raw: unknown): WebSearchResponse {
  const parsed = ExaSearchResponseSchema.parse(raw)
  return {
    hits: parsed.results.map((r) => {
      const snippet = r.highlights?.length ? r.highlights.join(' ... ') : r.text ?? ''
      return {
        url: r.url,
        title: r.title,
        snippet,
        ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
      }
    }),
  }
}

export class ExaWebSearchProvider extends BaseWebSearchProvider {
  readonly id: WebSearchProviderId = 'exa'
  readonly name = 'Exa'
  protected readonly settingsKeyField: keyof ApiKeySettings = 'exaApiKey'
  protected readonly envVarName = 'EXA_API_KEY'

  async search(query: string, opts: WebSearchOptions): Promise<WebSearchResponse> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Exa API key not configured')

    const body = JSON.stringify({
      query,
      numResults: this.clampNumResults(opts.numResults),
      includeDomains: opts.includeDomains,
      excludeDomains: opts.excludeDomains,
      startPublishedDate: opts.startPublishedDate,
      endPublishedDate: opts.endPublishedDate,
      // Request BOTH content types: highlights (the snippet source) + text (fallback when a page
      // returns no highlights). Exa bills ~$1/1k pages PER content type, so this roughly doubles
      // content cost. Kept intentionally for v1 (snippet quality over spend); to cost-optimize
      // later, drop to a single source — likely highlights-only, which fits search=relevance-preview
      // while web_fetch owns full content. Verified live 2026-06-30: both come back, body accepted.
      contents: { highlights: true, text: { maxCharacters: 800 } },
    })

    const json = await this.fetchJson(EXA_SEARCH_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body,
    })
    return mapExaSearchResponse(json)
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    return this.runValidation((signal) =>
      fetch(EXA_SEARCH_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'test', numResults: 1 }),
        signal,
      }),
    )
  }
}
