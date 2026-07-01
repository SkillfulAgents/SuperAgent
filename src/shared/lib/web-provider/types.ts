// Normalized web-search seam types (v1, locked minimal cut). One shape the host sees
// regardless of vendor. The fuller multi-vendor surface (capability-gated option knobs,
// gated hit fields, usage/requestId) is a Slice-2 extension, added per field when a
// consumer needs it — each is a pure, non-breaking widening.

// 'native' is the default sentinel (Anthropic server-side tools, no host provider);
// 'exa' is the reference vendor. Other vendors join the union as they are built.
export type WebSearchProviderId = 'native' | 'exa'

export interface WebSearchOptions {
  numResults?: number // host applies a default + hard max (Exa bills per result)
  includeDomains?: string[] // model intent; the same field feeds the allowed-sites host filter
  excludeDomains?: string[]
  startPublishedDate?: string // ISO 8601
  endPublishedDate?: string
}

export interface WebSearchHit {
  url: string
  title: string | null // present on every vendor; value may be null
  snippet: string // short relevant excerpt (for Exa, normalized from highlights)
  publishedDate?: string // ISO 8601; omitted where the vendor returns none
}

export interface WebSearchResponse {
  hits: WebSearchHit[]
  warnings?: string[] // e.g. allowed-sites "N results removed by your policy"
  // whole-request error model: search() throws on failure; per-result failure is a fetch concern
}

// Normalized web-FETCH seam types (v1, locked minimal cut). Single document in, single document
// out — a fetch returns one page's full content, not a ranked hit array. Same 'native' default
// sentinel + 'exa' reference vendor as search; the fuller multi-vendor surface (capabilities,
// per-URL outcome envelope, usage, gated body fields) is a Slice-2 extension (see deferred block).
export type WebFetchProviderId = 'native' | 'exa'

export interface WebFetchOptions {
  maxChars?: number // -> Exa text.maxCharacters (content-length bound); the only option wired end-to-end in v1
  // ---- Slice-2 deferred (re-add per field, wired end-to-end, when a consumer needs it) ----
  // maxAgeHours? (Exa cache-freshness intent), format?, verbosity?, includeSections?,
  // excludeSections?, highlights?, objective?
}

export interface WebFetchResult {
  url: string
  title: string | null // present on every vendor; value may be null
  content: string // the page's extracted text (Exa `text`)
  publishedDate?: string // ISO 8601; omitted where the vendor returns none
  fetchedAt: string // HOST-STAMPED at fetch time (no vendor returns this)
}

export interface WebFetchResponse {
  result: WebFetchResult
  warnings?: string[] // e.g. allowed-sites rejection, cache-bypass annotation
  // whole-request error model: fetch() throws on failure (mirrors search())
}

// ---- Slice-2 deferred (do NOT build now; re-add per field when fetch vendor #2 lands) ----
// WebFetchCapabilities (the Zod capabilities object), the per-URL WebFetchOutcome[] envelope +
// batch fan-out, WebProviderUsage (requestId/costDollars), and all gated body fields
// (highlights / excerpts / author / html / metadata). Each is a pure, non-breaking widening.
