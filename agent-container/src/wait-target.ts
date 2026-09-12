/**
 * browser_wait target classification and result wording.
 *
 * The tool exposes one string, `for`, and the route used to pass it to the
 * CLI untouched and print a constant `Wait condition "X" satisfied.` with no
 * elapsed time. So `body`/`img`/`h1` resolved at t≈0 and read as a real wait
 * — agents used the tool as a sleep 19×, 102× in single sessions believing
 * they were throttling — and Playwright locator syntax (`text=Trigger`,
 * `:has-text(...)`) burned the full 25s timeout on every call, sixteen of
 * sixteen in one session (transcript-mining theme 10).
 *
 * The result now states what was waited for and how long it took; syntax
 * the CLI cannot take is refused up front, naming the mode that does the
 * job. Neither is a judgement about the page.
 */

export const WAIT_LOAD_STATES = ['networkidle', 'load', 'domcontentloaded'] as const

export type WaitTarget =
  | { kind: 'selector'; args: string[] }
  | { kind: 'ms'; ms: number; args: string[] }
  | { kind: 'load'; state: string; args: string[] }
  | { kind: 'rejected'; reason: string }

const PLAYWRIGHT_PREFIX = /^\s*(text|role|id|xpath|css|data-testid)\s*=/i
const PLAYWRIGHT_PSEUDO = /:has-text\(|:text\(|:text-is\(|:nth-match\(|>>/

/**
 * The selector with its quoted strings blanked out, so `>>` or `:has-text(`
 * inside an attribute value (`button[data-note="a>>b"]`, valid CSS the CLI
 * accepts) is not mistaken for Playwright syntax. Escapes inside quotes are
 * honoured; an unterminated quote blanks to the end.
 */
export function stripQuotedStrings(s: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) { quote = null; out += ch }
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue }
    out += ch
  }
  return out
}

/** In-page probe used around waits: where the page is and whether it finished loading. */
export const WAIT_PAGE_PROBE_SCRIPT = 'JSON.stringify({u:String(location.href||""),r:String(document.readyState||"")})'

export function parseWaitPageProbe(stdout: string): { url: string; readyState: string } | null {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    const o = parsed as Record<string, unknown> | null
    if (!o || typeof o.u !== 'string') return null
    return { url: o.u, readyState: typeof o.r === 'string' ? o.r : '' }
  } catch {
    return null
  }
}

/** Map the tool's `for` argument to CLI args, or refuse it with the alternative named. */
export function classifyWaitTarget(raw: string): WaitTarget {
  const s = raw.trim()
  if (/^\d+$/.test(s)) {
    return { kind: 'ms', ms: Number(s), args: ['wait', s] }
  }
  if ((WAIT_LOAD_STATES as readonly string[]).includes(s)) {
    return { kind: 'load', state: s, args: ['wait', '--load', s] }
  }
  // The prefix test runs on the raw start: no CSS selector begins `text=`.
  if (PLAYWRIGHT_PREFIX.test(s)) {
    return {
      kind: 'rejected',
      reason:
        `"${s}" is Playwright locator syntax, not a CSS selector, and the CLI would wait the full timeout without matching. ` +
        'To wait for text on the page use browser_run(["wait","--text","<text>"]); for a URL, browser_run(["wait","--url","<pattern>"]); otherwise pass a CSS selector.',
    }
  }
  if (PLAYWRIGHT_PSEUDO.test(stripQuotedStrings(s))) {
    return {
      kind: 'rejected',
      reason:
        `"${s}" uses Playwright-only selector syntax (:has-text, :text, >>), which the CLI does not accept. ` +
        'Use plain CSS, or browser_run(["wait","--text","<text>"]) to wait for text.',
    }
  }
  return { kind: 'selector', args: ['wait', s] }
}

/**
 * The result line: what was waited for, how long it actually took, and —
 * when the route could read it — where the page is now, so a navigation
 * that finished during the wait is visible on the result itself.
 */
export function formatWaitResult(target: WaitTarget, elapsedMs: number, timedOut: boolean, url?: string): string {
  const ms = Math.max(0, Math.round(elapsedMs))
  const page = url ? ` Page: ${url}` : ''
  switch (target.kind) {
    case 'ms':
      return `Waited ${ms} ms.${page}`
    case 'load':
      return (timedOut
        ? `Load state "${target.state}" was not reached within ${ms} ms.`
        : `Load state "${target.state}" reached after ${ms} ms.`) + page
    case 'selector':
      return `Selector ${JSON.stringify(target.args[1])} matched after ${ms} ms.${page}`
    case 'rejected':
      return target.reason
  }
}
