/**
 * Post-action state digest (browser-tools audit P1 #7).
 *
 * Every mutating browser tool used to return a fixed acknowledgment with zero
 * post-action state ("Clicked eN. Use browser_snapshot to see the updated
 * page.") — institutionalizing a 2–3-call minimum per interaction and hiding
 * navigations, fill rejections, and silent no-ops (audit F1, ~235 wasted
 * calls). These helpers attach what the agent actually needs to know: did the
 * page navigate, what's the URL now, did the value commit, where is the
 * viewport.
 *
 * The tree-diff part of the original design is deliberately deferred: running
 * a snapshot per action would rotate the CLI's ref registry and fire the
 * stale-ref renumbering trap (upstream vercel-labs/agent-browser#1443) after
 * every single action.
 */

/** Settle delays before reading post-action state (React/async effects). */
export const CLICK_SETTLE_MS = 300
export const FILL_SETTLE_MS = 200
export const PRESS_ENTER_SETTLE_MS = 300
export const PRESS_SETTLE_MS = 50

// --- URL tracking ----------------------------------------------------------
// One `get url` per action, compared against the last observation, instead of
// before/after reads on every call.

let lastKnownUrl: string | null = null

export function resetUrlTracking(): void {
  lastKnownUrl = null
}

export interface UrlDigest {
  url: string
  /** URL differs from the last observation (includes navigations that
   * happened between actions, not only ones caused by this action). */
  navigated: boolean
  /** No prior observation existed — "unchanged" cannot be claimed. */
  firstObservation: boolean
}

/** Record the current URL and report whether it changed since last seen. */
export function observeUrl(currentUrl: string): UrlDigest {
  const previous = lastKnownUrl
  lastKnownUrl = currentUrl
  return {
    url: currentUrl,
    navigated: previous !== null && previous !== currentUrl,
    firstObservation: previous === null,
  }
}

/** Render the URL digest for click results (always shows the URL). */
export function formatUrlDigest(digest: UrlDigest | null): string {
  if (!digest) return ''
  if (digest.navigated) {
    return `\nPage NAVIGATED — now at ${digest.url}. Refs from previous snapshots are stale; take a fresh browser_snapshot before further ref actions.`
  }
  if (digest.firstObservation) {
    return `\nNow at ${digest.url}.`
  }
  return `\nURL unchanged (${digest.url}). Re-snapshot only if you need to see resulting DOM changes.`
}

/** Render the URL digest for press results (quiet unless something moved). */
export function formatUrlDigestBrief(digest: UrlDigest | null): string {
  if (!digest) return ''
  if (digest.navigated) {
    return `\nPage NAVIGATED — now at ${digest.url}. Refs from previous snapshots are stale; take a fresh browser_snapshot before further ref actions.`
  }
  if (digest.firstObservation) {
    return ` (now at ${digest.url})`
  }
  return ' (URL unchanged)'
}

// --- Fill verification -------------------------------------------------------

const VALUE_DISPLAY_CAP = 120

function displayValue(value: string): string {
  return value.length > VALUE_DISPLAY_CAP ? `${value.slice(0, VALUE_DISPLAY_CAP)}…` : value
}

/**
 * Render the post-fill read-back. The CLI's fill sets the value
 * programmatically and reports success regardless of what the page kept —
 * maxlength truncation, JS reformatting, and keystroke-only widgets all
 * silently diverged in the audit (F6).
 */
export function formatFillReadback(requested: string, committed: string | null): string {
  if (committed === null) {
    return '\n(could not read the value back to verify)'
  }
  if (committed === requested) {
    return `\nField value verified: "${displayValue(committed)}".`
  }
  return `\n⚠ Field value is now "${displayValue(committed)}" — differs from the requested "${displayValue(requested)}". The site reformatted, truncated (maxlength), or rejected the input. If this matters, fix it before moving on; keystroke-listening widgets may need browser_type instead.`
}

// --- Scroll position ---------------------------------------------------------

export interface ScrollInfo {
  y: number
  viewportHeight: number
  pageHeight: number
}

/** Parse the eval output of the scroll-info probe (double-JSON-encoded by the CLI). */
export function parseScrollInfo(stdout: string): ScrollInfo | null {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    const o = parsed as Record<string, unknown>
    if (typeof o.y === 'number' && typeof o.vh === 'number' && typeof o.h === 'number') {
      return { y: o.y, viewportHeight: o.vh, pageHeight: o.h }
    }
    return null
  } catch {
    return null
  }
}

export function formatScrollDigest(info: ScrollInfo | null): string {
  if (!info) return ''
  const bottom = Math.min(info.y + info.viewportHeight, info.pageHeight)
  const atBottom = bottom >= info.pageHeight
  const atTop = info.y === 0
  let position = ''
  if (atTop) position = ' (top of page)'
  else if (atBottom) position = ' (bottom of page)'
  return `\nViewport now shows ${Math.round(info.y)}–${Math.round(bottom)} of ${Math.round(info.pageHeight)}px${position}.`
}
