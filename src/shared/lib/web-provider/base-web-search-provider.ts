import { BaseWebProvider } from './base-web-provider'
import type { WebSearchOptions, WebSearchProviderId, WebSearchResponse } from './types'

// Shared result clamp: every vendor clamps results to the same host cap (vendors bill per result).
const DEFAULT_NUM_RESULTS = 10
const MAX_NUM_RESULTS = 25

/**
 * Host-side seam for a swappable web-search vendor. Credential + transport plumbing lives in
 * BaseWebProvider; a search vendor only builds its request, maps its response, and shares the
 * result clamp below.
 */
export abstract class BaseWebSearchProvider extends BaseWebProvider {
  abstract readonly id: WebSearchProviderId

  /** Run a ranked web search and return normalized hits. Throws on a whole-request failure. */
  abstract search(query: string, opts: WebSearchOptions): Promise<WebSearchResponse>

  /** Clamp a requested result count into [1, MAX_NUM_RESULTS], defaulting when unset. */
  protected clampNumResults(n?: number): number {
    if (n == null) return DEFAULT_NUM_RESULTS
    return Math.max(1, Math.min(n, MAX_NUM_RESULTS))
  }
}
