import type { ApiKeySettings } from '../config/settings'
import { NonRetryableError, withRetry } from '../utils/retry'
import { BaseWebSearchProvider } from './base-web-search-provider'
import { FirecrawlSearchResponseSchema } from './firecrawl-response-schema'
import type { WebSearchOptions, WebSearchProviderId, WebSearchResponse } from './types'

const FIRECRAWL_SEARCH_URL = 'https://api.firecrawl.dev/v2/search'
const DEFAULT_NUM_RESULTS = 10
const MAX_NUM_RESULTS = 25 // host hard cap (Firecrawl bills credits per result; OpenAPI allows ≤100)
const MAX_QUERY_LENGTH = 500 // Firecrawl rejects queries longer than this with a 400
const REQUEST_TIMEOUT_MS = 15_000
const RETRY_ATTEMPTS = 2 // 1 retry; native gives resilience implicitly, a vendor swap removes it (§13)
const RETRY_BASE_DELAY_MS = 500

/**
 * Map a raw Firecrawl POST /v2/search response into the normalized WebSearchResponse.
 * Parses at the boundary (Zod) then maps explicitly. Snippet is Firecrawl's `description`. Web
 * search results carry no date field (only `news[]` has `date`), so `publishedDate` is left
 * unmapped (§15).
 */
export function mapFirecrawlSearchResponse(raw: unknown): WebSearchResponse {
  const parsed = FirecrawlSearchResponseSchema.parse(raw)
  return {
    hits: (parsed.data.web ?? []).map((r) => ({
      url: r.url,
      title: r.title ?? null,
      snippet: r.description ?? '',
    })),
  }
}

function clampNumResults(n?: number): number {
  if (n == null) return DEFAULT_NUM_RESULTS
  return Math.max(1, Math.min(n, MAX_NUM_RESULTS))
}

/** Convert an ISO `YYYY-MM-DD` (or datetime) to Firecrawl's US `M/D/YYYY` tbs form (non-padded). */
function toUsDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${Number(m)}/${Number(d)}/${y}`
}

/**
 * Build Firecrawl's `tbs` custom date-range string, or undefined when no bounds are set. Maps
 * startPublishedDate→cd_min and endPublishedDate→cd_max; a one-sided range sets only the bound it has.
 */
function buildTbs(opts: WebSearchOptions): string | undefined {
  if (!opts.startPublishedDate && !opts.endPublishedDate) return undefined
  const parts = ['cdr:1']
  if (opts.startPublishedDate) parts.push(`cd_min:${toUsDate(opts.startPublishedDate)}`)
  if (opts.endPublishedDate) parts.push(`cd_max:${toUsDate(opts.endPublishedDate)}`)
  return parts.join(',')
}

export class FirecrawlWebSearchProvider extends BaseWebSearchProvider {
  readonly id: WebSearchProviderId = 'firecrawl'
  readonly name = 'Firecrawl'
  protected readonly settingsKeyField: keyof ApiKeySettings = 'firecrawlApiKey'
  protected readonly envVarName = 'FIRECRAWL_API_KEY'

  async search(query: string, opts: WebSearchOptions): Promise<WebSearchResponse> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('Firecrawl API key not configured')

    // No scrapeOptions/sources → search returns title/description/url and we dodge the formats
    // oneOf trap and the success-stays-true page-failure trap (those only bite on scrape). include
    // and exclude domains are mutually exclusive, so include wins and excludes degrade host-side.
    const body: Record<string, unknown> = {
      query: query.slice(0, MAX_QUERY_LENGTH),
      limit: clampNumResults(opts.numResults),
    }
    if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains
    else if (opts.excludeDomains?.length) body.excludeDomains = opts.excludeDomains
    const tbs = buildTbs(opts)
    if (tbs) body.tbs = tbs

    const json = await withRetry(
      async () => {
        const res = await fetch(FIRECRAWL_SEARCH_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        if (!res.ok) {
          const message = `Firecrawl search failed: ${res.status}`
          if (res.status === 429 || res.status >= 500) throw new Error(message)
          throw new NonRetryableError(message)
        }
        return res.json()
      },
      RETRY_ATTEMPTS,
      RETRY_BASE_DELAY_MS,
    )
    const response = mapFirecrawlSearchResponse(json)
    const warnings = opts.includeDomains?.length && opts.excludeDomains?.length
      ? ['Firecrawl cannot combine include and exclude domains; excludeDomains was ignored.']
      : []
    return warnings.length ? { ...response, warnings } : response
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await fetch(FIRECRAWL_SEARCH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'test', limit: 1 }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' }
      return { valid: false, error: `Firecrawl API error: ${res.status}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return { valid: false, error: `Network error: ${message}` }
    }
  }
}
