/**
 * Format the host /web-search/search response into the text block the agent reads.
 * Pure (no SDK / network) so it is unit-testable. The leading `Links: [...]` line is the
 * renderer contract (tool-renderers/web-search.tsx parses it); the numbered list below it
 * is what the model reasons over.
 */

export interface WebSearchHostHit {
  url: string
  title: string | null
  snippet: string
  publishedDate?: string
}

export interface WebSearchHostResult {
  hits: WebSearchHostHit[]
  warnings?: string[]
}

export function formatWebSearchResults(data: WebSearchHostResult): string {
  const links = data.hits.map((h) => ({ title: h.title ?? h.url, url: h.url }))
  const lines: string[] = [`Links: ${JSON.stringify(links)}`, '']

  if (data.hits.length === 0) {
    lines.push('No results found.')
  } else {
    data.hits.forEach((h, i) => {
      lines.push(`${i + 1}. ${h.title ?? h.url}`)
      lines.push(`   ${h.url}`)
      if (h.publishedDate) lines.push(`   Published: ${h.publishedDate}`)
      if (h.snippet) lines.push(`   ${h.snippet}`)
      lines.push('')
    })
  }

  if (data.warnings && data.warnings.length > 0) {
    lines.push(`Note: ${data.warnings.join('; ')}`)
  }

  return lines.join('\n')
}
