import { BaseWebProvider } from './base-web-provider'
import type { WebFetchOptions, WebFetchProviderId, WebFetchResult } from './types'

// Shared content bound: when the caller requests a content-length cap, clamp it into a sane range
// before handing it to the vendor (defense-in-depth; the host route also re-caps returned content).
const MAX_FETCH_CHARS = 100_000

/**
 * Host-side seam for a swappable web-fetch vendor. Credential + transport plumbing lives in
 * BaseWebProvider; a fetch vendor only builds its request and maps its response into a single
 * normalized document. No `capabilities` object (Slice-2 deferred).
 */
export abstract class BaseWebFetchProvider extends BaseWebProvider {
  abstract readonly id: WebFetchProviderId

  /**
   * Fetch a single URL's full content and return one normalized document. Throws on a whole-request
   * failure (mirrors search's error model).
   */
  abstract fetch(url: string, opts: WebFetchOptions): Promise<WebFetchResult>

  /** Clamp a requested content-char bound into [1, MAX_FETCH_CHARS]; undefined stays undefined. */
  protected clampMaxChars(n?: number): number | undefined {
    if (n == null) return undefined
    return Math.max(1, Math.min(n, MAX_FETCH_CHARS))
  }
}
