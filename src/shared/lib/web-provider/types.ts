// Normalized web-search seam types (v1, locked minimal cut). One shape the host sees
// regardless of vendor. The fuller multi-vendor surface (capability-gated option knobs,
// gated hit fields, usage/requestId) is a Slice-2 extension, added per field when a
// consumer needs it — each is a pure, non-breaking widening.

// 'native' is the default sentinel (Anthropic server-side tools / Claude's built-in tools, no host
// provider); 'exa' is the reference vendor; 'platform' is the Gamut-provided vendor (same Exa shape,
// routed through the platform proxy on the user's login). One id union for the whole web seam — the
// same vendor backs both search and fetch, and advertises which it supports via its optional
// search()/fetch() methods. Other vendors join the union as they are built.
export type WebProviderId = 'native' | 'exa' | 'platform'

// What a vendor costs the user, and the ONLY input to automatic precedence. The rule: never spend a
// credential the user supplied when something already covered by their plan can do the job. 'native'
// has no tier because it is not a provider — it is the floor the ladder falls back to.
//   'included' — comes with the Gamut plan; the user pays nothing beyond the login they already have
//   'byok'     — runs on a key the user or operator supplied, and spends it
// A new vendor ranks itself by answering this one question. Nothing else needs to change.
export type WebVendorTier = 'included' | 'byok'

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
// out — a fetch returns one page's full content, not a ranked hit array. The fuller multi-vendor
// surface (capabilities, per-URL outcome envelope, usage, gated body fields) is a Slice-2 extension
// (see deferred block).

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
