/**
 * Desktop provenance for issuing a cross-site session cookie on token exchange.
 * A browser POST (Origin present, or a document/iframe navigation) stays JSON-only.
 */
export function isDesktopCookieCaller(headers: {
  get(name: string): string | null
}): boolean {
  if (headers.get('origin')) return false
  const dest = (headers.get('sec-fetch-dest') ?? '').toLowerCase()
  const mode = (headers.get('sec-fetch-mode') ?? '').toLowerCase()
  if (dest === 'document' || dest === 'iframe' || dest === 'embed' || dest === 'frame') {
    return false
  }
  if (mode === 'navigate') return false
  return true
}
