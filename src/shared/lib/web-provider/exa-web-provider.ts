import type { ApiKeySettings } from '../config/settings'
import { BaseWebProvider } from './base-web-provider'
import { ExaContentsResponseSchema } from './exa-contents-response-schema'
import { ExaSearchResponseSchema } from './exa-response-schema'
import type {
  WebFetchOptions,
  WebFetchResult,
  WebProviderId,
  WebSearchOptions,
  WebSearchResponse,
} from './types'

const EXA_SEARCH_URL = 'https://api.exa.ai/search'
const EXA_CONTENTS_URL = 'https://api.exa.ai/contents'

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
    title: first.title ?? null, // failed/empty stubs (filterEmptyResults:false) may omit title
    content: first.text ?? '',
    ...(first.publishedDate ? { publishedDate: first.publishedDate } : {}),
    fetchedAt,
  }
}

/**
 * The Exa POST /search request body. Shared with PlatformWebProvider, which reaches the same Exa
 * API through the platform proxy — the vendors differ only in URL and auth, so the body (and its
 * two load-bearing choices below) lives in one place rather than being kept in sync by hand.
 * `numResults` arrives pre-clamped by the caller's BaseWebProvider.
 */
export function buildExaSearchBody(query: string, opts: WebSearchOptions, numResults: number): string {
  return JSON.stringify({
    query,
    numResults,
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
}

/**
 * The Exa POST /contents request body. Shared with PlatformWebProvider (see above).
 * `maxChars` arrives pre-clamped by the caller's BaseWebProvider; undefined means no cap.
 */
export function buildExaContentsBody(url: string, maxChars: number | undefined): string {
  return JSON.stringify({
    urls: [url],
    // A bare `true` returns full text; a cap object bounds it when the caller asked for maxChars.
    text: maxChars != null ? { maxCharacters: maxChars } : true,
    // ALWAYS false: Exa defaults this to true, which silently DROPS a failed/empty URL from
    // results[] and breaks one-doc-per-URL mapping (§15). false keeps it so we map empty content.
    filterEmptyResults: false,
  })
}

/**
 * The Exa reference vendor — one class exposing both web operations. `search` hits POST /search;
 * `fetch` hits POST /contents. Both resolve the key per call, run under the shared transport
 * (BaseWebProvider timeout + retry), and map explicitly through a Zod boundary.
 */
export class ExaWebProvider extends BaseWebProvider {
  readonly id: WebProviderId = 'exa'
  readonly name = 'Exa'

  protected readonly settingsKeyField: keyof ApiKeySettings = 'exaApiKey'
  protected readonly envVarName = 'EXA_API_KEY'

  async search(query: string, opts: WebSearchOptions): Promise<WebSearchResponse> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Exa API key not configured')

    const json = await this.fetchJson(EXA_SEARCH_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: buildExaSearchBody(query, opts, this.clampNumResults(opts.numResults)),
    })
    return mapExaSearchResponse(json)
  }

  async fetch(url: string, opts: WebFetchOptions): Promise<WebFetchResult> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Exa API key not configured')

    const json = await this.fetchJson(EXA_CONTENTS_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: buildExaContentsBody(url, this.clampMaxChars(opts.maxChars)),
    })
    return mapExaContentsResponse(json, new Date().toISOString())
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
