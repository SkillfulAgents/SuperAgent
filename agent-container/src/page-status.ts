/**
 * Status line — the first consumer of the page observer.
 *
 * Every snapshot and every browser_open result opens with where the browser
 * is, what the page calls itself, whether the server said yes, whether it
 * finished loading and how many refs the tree holds — followed by the few
 * warnings that are certain from the observation (transcript-mining theme 2:
 * `(no interactive elements)` used to look the same for a hydrating SPA, a
 * 401 body, a Chrome error page and an Imperva ban).
 *
 * Each warning states an observation. Advice appears only where it leaves no
 * doubt (Chrome's own error page). An HTTP error status, a challenge wall or
 * a raw document are reported as facts the agent weighs itself.
 *
 * `waitForLoaded` holds a snapshot until the document has finished loading,
 * bounded, so the common "press Enter, snapshot" lands on the real page.
 */
import type { PageObservation } from './page-observer'

/** How long a snapshot waits for a loading document before reporting it as such. */
export const LOAD_WAIT_MS = 2000
export const LOAD_POLL_MS = 150

/**
 * Poll `read` until the document is complete or `capMs` elapses. A read that
 * fails (null) ends the wait — the status line will show the truth. Returns
 * the last observation so the caller does not pay a second read.
 */
export async function waitForLoaded(
  read: () => Promise<PageObservation | null>,
  opts: { capMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<{ obs: PageObservation | null; waitedMs: number }> {
  const capMs = opts.capMs ?? LOAD_WAIT_MS
  const pollMs = opts.pollMs ?? LOAD_POLL_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = opts.now ?? (() => Date.now())
  const start = now()
  let obs = await read()
  while (obs !== null && obs.readyState !== '' && obs.readyState !== 'complete' && now() - start < capMs) {
    await sleep(pollMs)
    obs = await read()
  }
  return { obs, waitedMs: now() - start }
}

/**
 * Warnings, ordered by how completely each one invalidates what follows: the
 * site did not load, a challenge wall is up, the document is not a web page,
 * it is still loading, or the tree is empty for none of those reasons.
 */
export function pageWarnings(obs: PageObservation, refCount: number | null, opts: { waitedMs?: number } = {}): string[] {
  const warns: string[] = []
  const waited = opts.waitedMs && opts.waitedMs >= 100 ? ` after waiting ${(opts.waitedMs / 1000).toFixed(1)}s` : ''
  if (obs.netError) {
    const code = obs.netError === 'net error' ? '' : ` (${obs.netError})`
    warns.push(`site unreachable${code} — this is Chrome's error page, not the site. Check the URL or retry.`)
  }
  if (obs.blocker) {
    warns.push(`${obs.blocker} challenge page — the site is challenging automated access; what follows is the challenge, not the site.`)
  }
  if (obs.contentType && !/html/i.test(obs.contentType)) {
    warns.push(`raw ${obs.contentType} document, not a web page — the tree shows Chrome's viewer.`)
  }
  if (obs.readyState && obs.readyState !== 'complete') {
    warns.push(`page still ${obs.readyState}${waited} — content may be incomplete.`)
  }
  if (refCount === 0 && warns.length === 0) {
    warns.push('no interactive elements — read the page text below before concluding the page is empty; an overlay, a login wall or a plain-text body all look like this.')
  }
  return warns
}

/**
 * The status line: `[page] https://… · "title" · HTTP 200 · complete · 84 refs`,
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
