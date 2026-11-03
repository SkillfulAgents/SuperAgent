import { getDomain } from 'tldts'

/**
 * The site a saved account belongs to: the host of the origin that holds the
 * sign-in fields, port included, without a leading "www." (login.github.com,
 * localhost:5173). Accounts match on it exactly, as browsers fill saved
 * passwords: tenants of a shared host (acme.okta.com, acme.slack.com) are
 * sites of their own, though no list of shared hosts names them. Null for
 * anything but an http(s) origin.
 */
export function siteOfOrigin(origin: string): string | null {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  return url.host.replace(/^www\./, '')
}

/**
 * The registrable domain a site is on (accounts.google.com → google.com),
 * private suffixes counted (acme.myshopify.com is its own); the site itself
 * when it has none (an IP address, localhost). For telling which sign-in
 * provider a site belongs to, never for matching accounts.
 */
export function registrableDomain(site: string): string {
  const hostname = site.replace(/:\d+$/, '')
  return getDomain(hostname, { allowPrivateDomains: true }) ?? site
}

/** How a username is compared: two saves of "Iddo@Example.com " are one account. */
export function usernameKey(username: string): string {
  return username.trim().toLowerCase()
}

/**
 * Whether the vault may fill an account saved on `savedOrigin` into a page on
 * `pageOrigin` without asking. The site already matches; plain HTTP to another
 * machine only takes what was saved over plain HTTP, never a secret first
 * typed into an encrypted page.
 */
export function vaultFillsInto(savedOrigin: string, pageOrigin: string): boolean {
  try {
    const page = new URL(pageOrigin)
    if (page.protocol === 'https:' || isLocalHost(page.hostname)) return true
    return new URL(savedOrigin).protocol === 'http:'
  } catch {
    return false
  }
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}
