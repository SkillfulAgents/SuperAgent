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

/** Map the tool's `for` argument to CLI args, or refuse it with the alternative named. */
export function classifyWaitTarget(raw: string): WaitTarget {
  const s = raw.trim()
  if (/^\d+$/.test(s)) {
    return { kind: 'ms', ms: Number(s), args: ['wait', s] }
  }
  if ((WAIT_LOAD_STATES as readonly string[]).includes(s)) {
    return { kind: 'load', state: s, args: ['wait', '--load', s] }
  }
  if (PLAYWRIGHT_PREFIX.test(s)) {
    return {
      kind: 'rejected',
      reason:
        `"${s}" is Playwright locator syntax, not a CSS selector, and the CLI would wait the full timeout without matching. ` +
        'To wait for text on the page use browser_run(["wait","--text","<text>"]); for a URL, browser_run(["wait","--url","<pattern>"]); otherwise pass a CSS selector.',
    }
  }
  if (PLAYWRIGHT_PSEUDO.test(s)) {
    return {
      kind: 'rejected',
      reason:
        `"${s}" uses Playwright-only selector syntax (:has-text, :text, >>), which the CLI does not accept. ` +
        'Use plain CSS, or browser_run(["wait","--text","<text>"]) to wait for text.',
    }
  }
  return { kind: 'selector', args: ['wait', s] }
}

/** The result line: what was waited for, and how long it actually took. */
export function formatWaitResult(target: WaitTarget, elapsedMs: number, timedOut: boolean): string {
  const ms = Math.max(0, Math.round(elapsedMs))
  switch (target.kind) {
    case 'ms':
      return `Waited ${ms} ms.`
    case 'load':
      return timedOut
        ? `Load state "${target.state}" was not reached within ${ms} ms.`
        : `Load state "${target.state}" reached after ${ms} ms.`
    case 'selector':
      return `Selector ${JSON.stringify(target.args[1])} matched after ${ms} ms.`
    case 'rejected':
      return target.reason
  }
}
