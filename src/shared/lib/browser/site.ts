import { getDomain } from 'tldts'

/** Registrable domain (eTLD+1) a saved login is keyed by; null when the URL has none. */
export function siteOf(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return getDomain(parsed.hostname, { allowPrivateDomains: true })
}
