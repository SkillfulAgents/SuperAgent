import type { ApiKeySettings } from '../config/settings'
import { BaseWebSearchProvider } from './base-web-search-provider'
import { YouSearchResponseSchema } from './youcom-response-schema'
import type { WebSearchOptions, WebSearchProviderId, WebSearchResponse } from './types'

const YOU_SEARCH_URL = 'https://ydc-index.io/v1/search'

/**
 * Map a raw You.com GET /v1/search response into the normalized WebSearchResponse.
 * Parses at the boundary (Zod) then maps explicitly. We read `results.web[]` only. A web result
 * with no url can't be a hit, so it's dropped rather than throwing the whole response away. The
 * snippet joins `description` + any `snippets`, matching the prior normalization pass.
 */
export function mapYouSearchResponse(raw: unknown): WebSearchResponse {
  const parsed = YouSearchResponseSchema.parse(raw)
  return {
    hits: (parsed.results.web ?? []).flatMap((r) => {
      if (!r.url) return []
      const snippet = [r.description, ...(r.snippets ?? [])].filter(Boolean).join(' ')
      return [
        {
          url: r.url,
          title: r.title ?? null,
          snippet,
          ...(r.page_age ? { publishedDate: r.page_age } : {}),
        },
      ]
    }),
  }
}

/**
 * Build the You.com search URL. `include_domains` and `exclude_domains` are mutually exclusive
 * (sending both is a 422), so include wins and excludes degrade to the host-side filter. `freshness`
 * needs both ends of the range, so a one-sided date bound is dropped (the open-ended form is
 * undocumented, §15).
 */
function buildSearchUrl(query: string, opts: WebSearchOptions, count: number): string {
  const params = new URLSearchParams()
  params.set('query', query)
  params.set('count', String(count))
  if (opts.includeDomains?.length) params.set('include_domains', opts.includeDomains.join(','))
  else if (opts.excludeDomains?.length) params.set('exclude_domains', opts.excludeDomains.join(','))
  if (opts.startPublishedDate && opts.endPublishedDate) {
    params.set('freshness', `${opts.startPublishedDate.slice(0, 10)}to${opts.endPublishedDate.slice(0, 10)}`)
  }
  return `${YOU_SEARCH_URL}?${params.toString()}`
}

export class YouComWebSearchProvider extends BaseWebSearchProvider {
  readonly id: WebSearchProviderId = 'youcom'
  readonly name = 'You.com'
  protected readonly settingsKeyField: keyof ApiKeySettings = 'youComApiKey'
  protected readonly envVarName = 'YOU_API_KEY'

  async search(query: string, opts: WebSearchOptions): Promise<WebSearchResponse> {
    const apiKey = this.getEffectiveApiKey()
    if (!apiKey) throw new Error('You.com API key not configured')

    const url = buildSearchUrl(query, opts, this.clampNumResults(opts.numResults))
    const json = await this.fetchSearchJson(url, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
    })
    const response = mapYouSearchResponse(json)
    const warnings: string[] = []
    if (opts.includeDomains?.length && opts.excludeDomains?.length) {
      warnings.push('You.com cannot combine include and exclude domains; excludeDomains was ignored.')
    }
    if (Boolean(opts.startPublishedDate) !== Boolean(opts.endPublishedDate)) {
      warnings.push('You.com date filtering needs both a start and end date; the date filter was not applied.')
    }
    return warnings.length ? { ...response, warnings } : response
  }

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    const params = new URLSearchParams({ query: 'test', count: '1' })
    return this.runValidation((signal) =>
      fetch(`${YOU_SEARCH_URL}?${params.toString()}`, {
        method: 'GET',
        headers: { 'X-API-Key': apiKey },
        signal,
      }),
    )
  }
}
