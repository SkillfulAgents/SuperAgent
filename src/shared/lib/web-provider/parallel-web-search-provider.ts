import type { ApiKeySettings } from '../config/settings'
import { NonRetryableError, withRetry } from '../utils/retry'
import { BaseWebSearchProvider } from './base-web-search-provider'
import { ParallelSearchResponseSchema } from './parallel-response-schema'
import type { WebSearchOptions, WebSearchProviderId, WebSearchResponse } from './types'

const PARALLEL_SEARCH_URL = 'https://api.parallel.ai/v1/search'
const DEFAULT_NUM_RESULTS = 10
const MAX_NUM_RESULTS = 25 // host hard cap (Parallel bills per result)
const REQUEST_TIMEOUT_MS = 15_000
const RETRY_ATTEMPTS = 2 // 1 retry; native gives resilience implicitly, a vendor swap removes it (§13)
const RETRY_BASE_DELAY_MS = 500

/**
 * Map a raw Parallel POST /v1/search response into the normalized WebSearchResponse.
 * Parses at the boundary (Zod) then maps explicitly, so there are no `as`-casts.
 * Snippet is normalized from Parallel's markdown `excerpts[]` (joined), matching how Exa joins
 * its highlights.
 */
export function mapParallelSearchResponse(raw: unknown): WebSearchResponse {
  const parsed = ParallelSearchResponseSchema.parse(raw)
  return {
    hits: parsed.results.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.excerpts?.length ? r.excerpts.join(' ... ') : '',
      ...(r.publish_date ? { publishedDate: r.publish_date } : {}),
    })),
  }
}

function clampNumResults(n?: number): number {
  if (n == null) return DEFAULT_NUM_RESULTS
  return Math.max(1, Math.min(n, MAX_NUM_RESULTS))
}

/**
 * Build Parallel's `source_policy` from the normalized options, or undefined when none apply.
 * `after_date` is `format: date`, so an ISO datetime is truncated to its date part. Parallel has
 * no upper-bound date field, so `endPublishedDate` is intentionally dropped (degrade, §15).
 */
function buildSourcePolicy(opts: WebSearchOptions): Record<string, unknown> | undefined {
  const policy: Record<string, unknown> = {}
  if (opts.includeDomains?.length) policy.include_domains = opts.includeDomains
  if (opts.excludeDomains?.length) policy.exclude_domains = opts.excludeDomains
  if (opts.startPublishedDate) policy.after_date = opts.startPublishedDate.slice(0, 10)
  return Object.keys(policy).length ? policy : undefined
}

export class ParallelWebSearchProvider extends BaseWebSearchProvider {
  readonly id: WebSearchProviderId = 'parallel'
  readonly name = 'Parallel'
  protected readonly settingsKeyField: keyof ApiKeySettings = 'parallelApiKey'
  protected readonly envVarName = 'PARALLEL_API_KEY'

  async search(query: string, opts: WebSearchOptions): Promise<WebSearchResponse> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Parallel API key not configured')

    const sourcePolicy = buildSourcePolicy(opts)
    // Parallel's schema is additionalProperties:false: max_results / source_policy MUST nest under
    // advanced_settings — flat keys are rejected (§15). `excerpts` come back by default (no flag).
    const body = JSON.stringify({
      objective: query,
      search_queries: [query],
      advanced_settings: {
        max_results: clampNumResults(opts.numResults),
        ...(sourcePolicy ? { source_policy: sourcePolicy } : {}),
      },
    })

    const json = await withRetry(
      async () => {
        const res = await fetch(PARALLEL_SEARCH_URL, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!res.ok) {
          const message = `Parallel search failed: ${res.status}`
          if (res.status === 429 || res.status >= 500) throw new Error(message)
          throw new NonRetryableError(message)
        }
        return res.json()
      },
      RETRY_ATTEMPTS,
      RETRY_BASE_DELAY_MS,
    )
    const response = mapParallelSearchResponse(json)
    const warnings = opts.endPublishedDate
      ? ['Parallel has no end-date filter; only startPublishedDate (a lower bound) was applied.']
      : []
    return warnings.length ? { ...response, warnings } : response
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await fetch(PARALLEL_SEARCH_URL, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ search_queries: ['test'], advanced_settings: { max_results: 1 } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' }
      return { valid: false, error: `Parallel API error: ${res.status}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { valid: false, error: `Network error: ${message}` }
    }
  }
}
