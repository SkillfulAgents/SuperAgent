/**
 * Status line — the first primitive built on the page observer.
 *
 * Every snapshot and every browser_open result opens with where the browser
 * is, what the page calls itself, whether the server said yes, whether it
 * finished loading, how many refs the tree holds, and whether the page is
 * still working — followed by the warnings the agent must act on before
 * reading anything below (transcript-mining theme 2: `(no interactive
 * elements)` used to look the same for a hydrating SPA, a 401 body, a Chrome
 * error page and an Imperva ban).
 *
 * `waitForQuiet` is the read-side twin of action-settle's poll: it holds a
 * snapshot until the document has loaded and the page has stopped working,
 * bounded, so the common "press Enter, snapshot" lands on the real page.
 */
import { describeBusy, transientBusy, type PageObservation } from './page-observer'
import { THIN_TREE_REFS } from './snapshot-format'

/** How long a snapshot waits for a loading or busy page before reporting it as such. */
export const QUIET_WAIT_MS = 2000
export const QUIET_POLL_MS = 150

/** A page is quiet when it has loaded and nothing transient says it is still working. */
export function isQuiet(obs: PageObservation): boolean {
  return obs.readyState === 'complete' && obs.pending === 0 && transientBusy(obs).length === 0
}

/**
 * Poll `read` until the page is quiet or `capMs` elapses. A read that fails
 * (null) ends the wait — the status line will show the truth. Returns the
 * last observation so the caller does not pay a second read.
 */
export async function waitForQuiet(
  read: () => Promise<PageObservation | null>,
  opts: { capMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<{ obs: PageObservation | null; waitedMs: number; quiet: boolean }> {
  const capMs = opts.capMs ?? QUIET_WAIT_MS
  const pollMs = opts.pollMs ?? QUIET_POLL_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = opts.now ?? (() => Date.now())
  const start = now()
  let obs = await read()
  while (obs !== null && !isQuiet(obs) && now() - start < capMs) {
    await sleep(pollMs)
    obs = await read()
  }
  return { obs, waitedMs: now() - start, quiet: obs !== null && isQuiet(obs) }
}

/** A tree too thin to be the page the agent asked for — the observer's census stands in when no snapshot was taken. */
export function isThinPage(obs: PageObservation, refCount: number | null): boolean {
  return (refCount ?? obs.interactive) < THIN_TREE_REFS
}

/**
 * Warnings the agent must act on before reading the tree, ordered by how
 * completely each one invalidates what follows: the site did not load, a bot
 * wall is up, the server refused, the document is not a web page, it is still
 * loading or still working, or the tree is empty for none of those reasons.
 *
 * Each one states an observation. Advice appears only where the observation
 * leaves no doubt (Chrome's own error page, a challenge wall); an HTTP error
 * status is reported as a fact on any page and as a warning only when the tree
 * is thin — a single-page app served from a 404 fallback is not an error page.
 */
export function pageWarnings(obs: PageObservation, refCount: number | null, opts: { waitedMs?: number } = {}): string[] {
  const warns: string[] = []
  const waited = opts.waitedMs && opts.waitedMs >= 100 ? ` after waiting ${(opts.waitedMs / 1000).toFixed(1)}s` : ''
  if (obs.netError) {
    const code = obs.netError === 'net error' ? '' : ` (${obs.netError})`
    warns.push(`site unreachable${code} — this is Chrome's error page, not the site. Check the URL or retry.`)
  }
  if (obs.blocker) {
    warns.push(`bot-block: ${obs.blocker} — the site is challenging automated access. Hand it to the user with request_browser_input; more scraping will not get past it.`)
  }
  if (obs.httpStatus >= 400 && isThinPage(obs, refCount)) {
    const why =
      obs.httpStatus === 401 ? ' (authentication required)' :
      obs.httpStatus === 404 ? ' (not found)' :
      obs.httpStatus === 429 ? ' (rate limited)' : ''
    warns.push(`HTTP ${obs.httpStatus}${why} — the server answered with an error status and almost nothing to interact with; what follows is that response.`)
  }
  if (obs.contentType && !/html/i.test(obs.contentType)) {
    warns.push(/pdf/i.test(obs.contentType)
      ? `PDF document, not a web page — the tree is Chrome's viewer, not the text. browser_download it and Read the file.`
      : `raw ${obs.contentType} document, not a web page — the body is plain text; read it with fullText:true.`)
  }
  if (obs.readyState && obs.readyState !== 'complete') {
    warns.push(`page still ${obs.readyState}${waited} — content may be incomplete.`)
  }
  const busy = describeBusy(obs.busy, obs.pending)
  if (busy) {
    warns.push(`page still active${waited}: ${busy}.`)
  }
  if (refCount === 0 && warns.length === 0) {
    warns.push('no interactive elements — read the page text below before concluding the page is empty; an overlay, a login wall or a plain-text body all look like this.')
  }
  return warns
}

/**
 * The status line: `[page] URL · "title" · HTTP 200 · complete · 84 refs`,
 * then one ⚠ line per warning. '' when the read could not run (no URL), so a
 * dead browser never gets a fake header.
 */
export function formatStatusLine(obs: PageObservation, refCount: number | null, opts: { waitedMs?: number } = {}): string {
  if (!obs.url) return ''
  const facts = [
    obs.url,
    obs.title ? JSON.stringify(obs.title.slice(0, 120)) : 'untitled',
  ]
  if (obs.httpStatus > 0) facts.push(`HTTP ${obs.httpStatus}`)
  if (obs.readyState) facts.push(obs.readyState)
  if (refCount !== null) facts.push(`${refCount} ref${refCount === 1 ? '' : 's'}`)
  const warns = pageWarnings(obs, refCount, opts)
  return `[page] ${facts.join(' · ')}` + warns.map(w => `\n⚠ ${w}`).join('')
}

/**
 * True when the browser landed somewhere other than what was asked for —
 * ignoring the differences a normal load introduces (scheme added, http→https
 * upgrade, trailing slash, fragment, case of the host).
 */
export function landedElsewhere(requested: string, landed: string): boolean {
  const norm = (u: string): string | null => {
    try {
      const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`
      const p = new URL(withScheme)
      const path = p.pathname.replace(/\/+$/, '')
      return `${p.host.toLowerCase()}${path}${p.search}`
    } catch {
      return null
    }
  }
  const a = norm(requested)
  const b = norm(landed)
  if (a === null || b === null) return false
  return a !== b
}
