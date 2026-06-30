import type { ApiKeySettings } from '../config/settings'
import { NonRetryableError, withRetry } from '../utils/retry'
import { BaseWebSearchProvider } from './base-web-search-provider'
import { ExaSearchResponseSchema } from './exa-response-schema'
import type { WebSearchOptions, WebSearchProviderId, WebSearchResponse } from './types'

const EXA_SEARCH_URL = 'https://api.exa.ai/search'
const DEFAULT_NUM_RESULTS = 10
const MAX_NUM_RESULTS = 25 // host hard cap (Exa bills per result)
const REQUEST_TIMEOUT_MS = 15_000
const RETRY_ATTEMPTS = 2 // 1 retry; native gives resilience implicitly, a vendor swap removes it (§13)
const RETRY_BASE_DELAY_MS = 500

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

function clampNumResults(n?: number): number {
  if (n == null) return DEFAULT_NUM_RESULTS
  return Math.max(1, Math.min(n, MAX_NUM_RESULTS))
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
      numResults: clampNumResults(opts.numResults),
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

    // Retry once on transient failures (429 / 5xx / timeout); a 4xx config error is
    // deterministic, so bypass the retry. The timeout guards a hung connection — global
    // fetch has none (§13).
    const json = await withRetry(
      async () => {
        const res = await fetch(EXA_SEARCH_URL, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!res.ok) {
          const message = `Exa search failed: ${res.status}`
          if (res.status === 429 || res.status >= 500) throw new Error(message)
          throw new NonRetryableError(message)
        }
        return res.json()
      },
      RETRY_ATTEMPTS,
      RETRY_BASE_DELAY_MS,
    )
    return mapExaSearchResponse(json)
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await fetch(EXA_SEARCH_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'test', numResults: 1 }),
      })
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' }
      return { valid: false, error: `Exa API error: ${res.status}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { valid: false, error: `Network error: ${message}` }
    }
  }
}
