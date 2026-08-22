import { getDomain } from 'tldts'
import { usernameOf, type OpLoginItem } from './op-schema'

/**
 * Maps a page address to the vault items that could log into it.
 *
 * Measured against the real vault: only 41% of login items record a website at
 * all, and 18 hosts carry more than one item. Matching therefore returns a
 * RANKED LIST for the user to confirm, never a single silent answer. Silent
 * auto-fill would guess wrong or find nothing most of the time.
 */

export interface CredentialCandidate {
  itemId: string
  title: string
  username: string | null
  /** The host recorded on the item that produced this match. */
  host: string
  confidence: 'exact' | 'domain' | 'site'
}

export interface CredentialIndex {
  /** normalized host -> items recording it */
  byHost: Map<string, OpLoginItem[]>
  builtAt: number
}

/** A search hit. Carries no secret — title and username only. */
export interface VaultSearchHit {
  itemId: string
  title: string
  username: string | null
}

/**
 * Find login items by title. A prefix match ranks above a substring match,
 * so typing "git" surfaces "GitHub" before "Digital Ocean".
 */
export function searchItemsByTitle(items: OpLoginItem[], query: string, limit = 20): VaultSearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []

  const prefix: OpLoginItem[] = []
  const substring: OpLoginItem[] = []
  for (const item of items) {
    const title = item.title.toLowerCase()
    if (title.startsWith(needle)) prefix.push(item)
    else if (title.includes(needle)) substring.push(item)
  }

  return [...prefix, ...substring].slice(0, limit).map((item) => ({
    itemId: item.id,
    title: item.title,
    username: usernameOf(item),
  }))
}

function registrableSite(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true })
}

const MIN_SITE_NAME_LENGTH = 4

/**
 * The name a user would type to find this site: `github` from github.com.
 * Short labels are skipped so `x.com` / `me.com` do not search the vault.
 */
export function siteNameQuery(pageUrl: string): string | null {
  const host = normalizeHost(pageUrl)
  if (!host) return null
  const site = registrableSite(host) ?? host
  const label = site.split('.')[0]
  if (!label || label.length < MIN_SITE_NAME_LENGTH) return null
  return label
}

export function normalizeHost(url: string): string | null {
  // 1Password's website field accepts a bare host with no scheme, which URL()
  // rejects. Seen on real items, so retry once with a scheme before giving up.
  const candidates = /^[a-z][a-z0-9+.-]*:/i.test(url) ? [url] : [url, `https://${url}`]
  for (const candidate of candidates) {
    try {
      const { hostname } = new URL(candidate)
      if (!hostname) continue
      const host = hostname.toLowerCase()
      return host.startsWith('www.') ? host.slice(4) : host
    } catch {
      // try the next shape
    }
  }
  return null
}

export function buildCredentialIndex(items: OpLoginItem[]): CredentialIndex {
  const byHost = new Map<string, OpLoginItem[]>()
  for (const item of items) {
    for (const url of item.urls) {
      const host = normalizeHost(url.href)
      if (!host) continue
      const bucket = byHost.get(host)
      if (bucket) bucket.push(item)
      else byHost.set(host, [item])
    }
  }
  return { byHost, builtAt: Date.now() }
}

export function matchCandidates(index: CredentialIndex, pageUrl: string): CredentialCandidate[] {
  const host = normalizeHost(pageUrl)
  if (!host) return []

  const out: CredentialCandidate[] = []
  const seen = new Set<string>()

  const push = (item: OpLoginItem, itemHost: string, confidence: 'exact' | 'domain' | 'site') => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    out.push({
      itemId: item.id,
      title: item.title,
      username: usernameOf(item),
      host: itemHost,
      confidence,
    })
  }

  for (const item of index.byHost.get(host) ?? []) push(item, host, 'exact')

  const site = registrableSite(host)

  // A parent domain is a weaker but real match: an item recorded on corp.com is
  // a plausible credential for sso.corp.com. The reverse does not hold, so this
  // only walks upward, and never past the registrable site.
  if (site) {
    for (const [itemHost, items] of index.byHost) {
      if (itemHost === host) continue
      if (!host.endsWith(`.${itemHost}`)) continue
      if (registrableSite(itemHost) !== site) continue
      for (const item of items) push(item, itemHost, 'domain')
    }

    for (const [itemHost, items] of index.byHost) {
      if (itemHost === host) continue
      if (registrableSite(itemHost) !== site) continue
      if (itemHost.endsWith(`.${host}`)) continue
      for (const item of items) push(item, itemHost, 'site')
    }
  }

  return out
}
