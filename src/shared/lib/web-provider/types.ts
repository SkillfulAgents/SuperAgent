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
