/**
 * A measurement, for the log alone: what changed outside an account's site
 * while its sign-in was watched. A saved session holds the account's site
 * (browser-session.ts), so an app that a sign-in on another host lands on
 * keeps its own session where no capture reads it: WSJ on wsj.com, after a
 * sign-in on sso.accounts.dowjones.com. The line names the cookie domains of
 * the site the agent's tab is on, with counts, and gives every other domain
 * as one count (trackers change cookies on any page). Never a cookie's name
 * or value.
 */
import { cookieFromSitePort, cookieInScope, type OutsideCookie } from './browser-session'

/** Domains named for the tab's site, at most. */
const MAX_NAMED_DOMAINS = 8

interface Tally {
  added: number
  changed: number
  removed: number
}

/** A cookie's domain, with the port that set it when that is not a scheme's default (dev servers on one host). */
function domainOf(cookie: OutsideCookie): string {
  const port = cookie.sourcePort
  return port === undefined || port < 0 || port === 80 || port === 443 ? cookie.domain : `${cookie.domain}:${port}`
}

function tallyText({ added, changed, removed }: Tally): string {
  return [added && `${added} new`, changed && `${changed} changed`, removed && `${removed} gone`].filter(Boolean).join(', ')
}

/** What changed outside a site, in two parts: the log repeats a line only when the first does. */
export interface OutsideChange {
  /** The cookie domains of the tab's site that changed, with counts: what a capture of the account's site leaves out. */
  onTab: string
  /** Every other domain as one count; trackers keep it moving. */
  elsewhere: string
}

/**
 * The cookies outside the site that changed between `before` (taken right
 * before a sign-in step) and `after`, described for the log; null when none
 * did. `tabSite` is where the agent's tab is now: a sign-in that landed on
 * an app shows that app's cookies there.
 */
export function describeOutside(before: readonly OutsideCookie[], after: readonly OutsideCookie[], tabSite: string | null): OutsideChange | null {
  const was = new Map(before.map((cookie) => [cookie.key, cookie]))
  const now = new Map(after.map((cookie) => [cookie.key, cookie]))
  const changes: Array<[OutsideCookie, keyof Tally]> = []
  for (const cookie of after) {
    const old = was.get(cookie.key)
    if (!old) changes.push([cookie, 'added'])
    else if (old.valueHash !== cookie.valueHash) changes.push([cookie, 'changed'])
  }
  for (const cookie of before) if (!now.has(cookie.key)) changes.push([cookie, 'removed'])
  if (changes.length === 0) return null

  const onTab = new Map<string, Tally>()
  const otherDomains = new Set<string>()
  let otherCookies = 0
  for (const [cookie, kind] of changes) {
    if (tabSite && cookieInScope(cookie.domain, tabSite) && cookieFromSitePort(cookie.sourcePort, tabSite)) {
      const tally = onTab.get(domainOf(cookie)) ?? { added: 0, changed: 0, removed: 0 }
      tally[kind]++
      onTab.set(domainOf(cookie), tally)
    } else {
      otherDomains.add(domainOf(cookie))
      otherCookies++
    }
  }
  const named = [...onTab].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const more = named.length > MAX_NAMED_DOMAINS ? `; ${named.length - MAX_NAMED_DOMAINS} more domain(s)` : ''
  const onTabText = tabSite === null
    ? 'the agent\'s tab shows no web page'
    : named.length === 0
      ? `nothing on the tab's site ${tabSite}`
      : `on the tab's site ${tabSite}: ${named.slice(0, MAX_NAMED_DOMAINS).map(([domain, tally]) => `${domain} ${tallyText(tally)}`).join('; ')}${more}`
  const elsewhere = otherCookies ? `${otherCookies} cookie(s) on ${otherDomains.size} other domain(s)` : 'no other domain'
  return { onTab: onTabText, elsewhere }
}
