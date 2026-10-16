/**
 * The address a Chrome error page stands for.
 *
 * When a navigation fails (ERR_CONNECTION_REFUSED on an OAuth redirect to a
 * localhost callback nobody listens on, SUP-997), Chrome commits its own
 * error document: `location.href` — and so `get url` and the observer — read
 * `chrome-error://chromewebdata/`, while the address bar still shows the URL
 * that failed, query string and all. Often that URL is the whole point (the
 * `code` of an OAuth callback), so every URL the agent is shown reports the
 * address bar instead.
 *
 * Chrome's own target list (`/json`, `Target.getTargets`) carries the address
 * bar's URL. The agent-browser daemon's tab list sometimes does too, but only
 * until the tab is switched away from and back — then it reads chrome-error://
 * as well (both verified in the container image). The daemon's tabs carry no
 * target id, so the error tab is paired with its target by elimination.
 */

export function isChromeErrorUrl(url: string): boolean {
  return /^chrome-error:/i.test(url.trim())
}

/**
 * `url` unchanged unless it is Chrome's error document; then the active tab's
 * address when one can be read, else `url` — never a guess.
 */
export async function resolveErrorPageUrl(
  url: string,
  activeTabUrl: () => Promise<string | null | undefined>,
): Promise<string> {
  if (!isChromeErrorUrl(url)) return url
  try {
    const address = (await activeTabUrl())?.trim()
    return address && !isChromeErrorUrl(address) ? address : url
  } catch {
    return url
  }
}

/**
 * The active tab's address given the daemon's tabs and Chrome's page targets.
 * A tab the daemon still knows by its real URL answers directly. Otherwise
 * every other tab claims the target with its URL; the one target left is the
 * error tab's. Two error tabs, or a target count that does not add up, leave
 * no single answer — null.
 */
export async function activeTabAddress(
  tabs: Array<{ url: string; active: boolean }>,
  targets: () => Promise<Array<{ url: string }>>,
  urlsMatch: (left: string, right: string) => boolean,
): Promise<string | null> {
  const active = tabs.find(t => t.active)
  if (!active) return null
  if (!isChromeErrorUrl(active.url)) return active.url
  if (tabs.filter(t => isChromeErrorUrl(t.url)).length !== 1) return null
  const left = [...await targets()]
  if (left.length !== tabs.length) return null
  for (const tab of tabs) {
    if (tab === active) continue
    const i = left.findIndex(t => urlsMatch(t.url, tab.url))
    if (i < 0) return null
    left.splice(i, 1)
  }
  return left[0].url
}
