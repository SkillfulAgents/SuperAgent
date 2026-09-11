/**
 * Snapshot scoping, full-text mode, iframe placeholders, and auto-degrade
 * (browser-tools audit P1 #10).
 *
 * The forced `-i -c` snapshot hard-failed the MCP token cap on ordinary
 * directory pages (66K chars on TAAFT, F7), blinding the agent at modal-
 * critical moments; it also strips ALL static text (validation errors,
 * prices, instructions — F5), and emits no marker for cross-origin iframes
 * whose fields are therefore invisible (Stripe Payment Element, P2). These
 * helpers add the scoping/full-text/url controls the CLI already supports but
 * the tool never exposed, surface iframe boundaries, and degrade gracefully
 * instead of erroring at the cap.
 */

/**
 * Auto-degrade threshold. The SDK tool-result token cap (~25k tokens) fires
 * around 62–74k chars of token-dense a11y text — nondeterministically at the
 * edge. Truncate well below that so a snapshot never hard-errors mid-flow.
 */
export const SNAPSHOT_SOFT_CAP_CHARS = 45_000

export interface IframeInfo {
  title: string
  host: string
  /** Contents reachable from the page's JS / merged into the snapshot. */
  sameOrigin: boolean
}

/** Parse the iframe-enumeration eval output (CLI double-JSON-encodes). */
export function parseIframeInfo(stdout: string): IframeInfo[] {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map(f => ({
        title: typeof f.title === 'string' ? f.title : '',
        host: typeof f.host === 'string' ? f.host : '',
        sameOrigin: f.sameOrigin === true,
      }))
  } catch {
    return []
  }
}

/**
 * Render placeholders for cross-origin iframes (whose fields the a11y snapshot
 * cannot see). Same-origin frames are already merged into the tree, so they
 * are omitted. Returns '' when there is nothing the agent is blind to.
 */
export function formatIframePlaceholders(iframes: IframeInfo[]): string {
  const opaque = iframes.filter(f => !f.sameOrigin && f.host)
  if (opaque.length === 0) return ''
  const lines = opaque.map(f => {
    const label = f.title ? `"${f.title}" ` : ''
    return `  - iframe ${label}(${f.host}) — contents NOT in this snapshot (cross-origin)`
  })
  return (
    `\n\nFrames on this page whose fields are not captured above:\n${lines.join('\n')}\n` +
    `If you need to fill a field inside one (e.g. card number in a payment frame), click into it by coordinates, then use browser_type.`
  )
}

/**
 * Cap snapshot text below the MCP token limit. When it would overflow, return
 * a truncated head plus guidance to scope — far better than the hard error
 * the cap produces (which leaves the agent with nothing).
 */
export function capSnapshot(text: string, scopeUsed: boolean): string {
  if (text.length <= SNAPSHOT_SOFT_CAP_CHARS) return text
  const scopeHint = scopeUsed
    ? 'Even scoped, this region is large — pass a tighter scope selector.'
    : 'Pass scope="<css selector>" (e.g. "form", "#main", ".modal", a dialog selector) to target just the region you need.'
  return (
    `${text.slice(0, SNAPSHOT_SOFT_CAP_CHARS)}\n` +
    `…[snapshot truncated — ${text.length} chars total, showing ${SNAPSHOT_SOFT_CAP_CHARS}. ${scopeHint}]`
  )
}

/**
 * What one page-probe eval tells us alongside the a11y tree. Runs once per
 * snapshot and once per open (it replaced the iframe-only probe and the
 * discarded `get url` read) so none of this costs an extra round trip.
 */
export interface PageProbe {
  iframes: IframeInfo[]
  /** Length of the page's visible text (`document.body.innerText`, whitespace-collapsed). */
  textChars: number
  /** Visible text of live regions: role=alert/status, aria-live (not "off"), <output>. */
  liveRegions: string[]
  /** Opening text of <main> (or body) — the page's gist. Longer when the tree is nearly empty. */
  preview: string
  /** location.href — '' when the probe could not run (dead browser, no page). */
  url: string
  title: string
  /** document.readyState: loading | interactive | complete. */
  readyState: string
  /** Navigation response status from PerformanceNavigationTiming (Chrome 109+); 0 when unknown (cache, file:, old Chrome). */
  httpStatus: number
  /** document.contentType, e.g. text/html, application/json, application/pdf. */
  contentType: string
  /** Visible loading indicators: aria-busy=true, role=progressbar, skeleton classes. */
  busy: number
  /** Bot-challenge vendor detected from title/body signatures, or ''. */
  blocker: string
  /** Chrome net-error code (ERR_NAME_NOT_RESOLVED …) when the document is Chrome's error page, or ''. */
  netError: string
}

export const EMPTY_PROBE: PageProbe = {
  iframes: [], textChars: 0, liveRegions: [], preview: '',
  url: '', title: '', readyState: '', httpStatus: 0, contentType: '', busy: 0, blocker: '', netError: '',
}

/** Below this much visible text the "text not shown" footer is noise (blank/loading pages). */
export const TEXT_FOOTER_MIN_CHARS = 200
export const PREVIEW_CHARS = 240
/** Preview length when the tree has fewer than THIN_TREE_REFS refs — the text is all the agent has. */
export const THIN_TREE_PREVIEW_CHARS = 1500
export const THIN_TREE_REFS = 5
const LIVE_REGION_MAX = 8
const LIVE_REGION_CHARS = 300

/**
 * Bot-challenge signatures, matched case-insensitively against title + the
 * first 3k chars of body text (and the URL for Google's /sorry/). Kept to
 * vendor-specific phrases: a generic "access denied" is often the app's own
 * auth wall, which the HTTP status and the text already convey.
 */
const BLOCKER_SIGNATURES: Array<[string, string]> = [
  ['Cloudflare', 'just a moment|checking your browser|verify you are human|cloudflare ray id|attention required.{0,40}cloudflare|cf-browser-verification'],
  ['Imperva/Incapsula', 'incapsula|imperva|incident id|request unsuccessful\\.'],
  ['Akamai', 'reference #\\d+\\.[0-9a-f]+\\.\\d+|access denied.{0,120}permission to access'],
  ['Google', '/sorry/|unusual traffic from your computer network'],
  ['PerimeterX', 'press (&|and) hold|px-captcha|perimeterx'],
  ['DataDome', 'datadome'],
  ['CAPTCHA', 'hcaptcha|recaptcha|arkose|funcaptcha'],
]

/**
 * One eval, one JSON object: cross-origin iframes (their fields are invisible
 * to the a11y tree), how much text the page has (the interactive view drops
 * all of it), what the live regions currently say (validation errors, toasts,
 * status lines), the opening words of <main>, and the page's identity and
 * readiness (URL, title, HTTP status, readyState, content type, loading
 * indicators, bot-challenge and net-error signatures). Each part is wrapped
 * in its own try so a hostile page cannot blank the others. Visibility uses
 * getClientRects, not offsetParent — offsetParent is null for position:fixed
 * toasts, which are exactly the live regions we want.
 */
export function pageProbeScript(opts: { previewChars?: number } = {}): string {
  const previewChars = opts.previewChars ?? PREVIEW_CHARS
  const sigs = JSON.stringify(BLOCKER_SIGNATURES)
  return (
    '(function(){var o={iframes:[],textChars:0,live:[],preview:"",url:"",title:"",readyState:"",http:0,contentType:"",busy:0,blocker:"",netError:""};' +
    'var ws=function(s){return String(s||"").replace(/\\s+/g," ").trim()};var body="";' +
    // checkVisibility also excludes visibility:hidden / opacity:0 (see action-effect.ts).
    'var vis=function(el){try{if(typeof el.checkVisibility==="function")return el.checkVisibility({visibilityProperty:true,opacityProperty:true,checkVisibilityCSS:true,checkOpacity:true});return el.getClientRects().length>0}catch(e){return false}};' +
    'try{o.url=String(location.href||"")}catch(e){}' +
    'try{o.title=ws(document.title).slice(0,200);o.readyState=String(document.readyState||"");o.contentType=String(document.contentType||"")}catch(e){}' +
    'try{var nav=performance.getEntriesByType("navigation")[0];o.http=(nav&&nav.responseStatus)|0}catch(e){}' +
    'try{o.iframes=[...document.querySelectorAll("iframe")].filter(function(f){return f.offsetParent!==null})' +
    '.map(function(f){var host="";try{host=new URL(f.src).host}catch(e){}var same=false;try{same=!!f.contentDocument}catch(e){}' +
    'return{title:f.title||"",host:host,sameOrigin:same}})}catch(e){}' +
    'try{body=ws(document.body&&document.body.innerText);o.textChars=body.length}catch(e){}' +
    'try{var seen={};var els=document.querySelectorAll(\'[role="alert"],[role="status"],[aria-live]:not([aria-live="off"]),output\');' +
    'for(var i=0;i<els.length&&o.live.length<' + LIVE_REGION_MAX + ';i++){var el=els[i];if(!vis(el))continue;' +
    'var s=ws(el.innerText);if(!s||seen[s])continue;seen[s]=1;o.live.push(s.slice(0,' + LIVE_REGION_CHARS + '))}}catch(e){}' +
    'try{var m=document.querySelector("main,[role=main]")||document.body;o.preview=ws(m&&m.innerText).slice(0,' + previewChars + ')}catch(e){}' +
    'try{var bs=document.querySelectorAll(\'[aria-busy="true"],[role="progressbar"],[class*="skeleton"]\');' +
    'for(var b=0;b<bs.length;b++){if(vis(bs[b]))o.busy++}}catch(e){}' +
    // Chrome's error document: full Chrome renders #main-frame-error with the
    // ERR_ code in its text; the headless shell shows an empty page whose only
    // tell is the chrome-error:// URL (verified in the container image).
    'try{if(document.getElementById("main-frame-error")||/^chrome-error:/.test(o.url)){var em=/\\bERR_[A-Z_]{3,}\\b/.exec(body);o.netError=em?em[0]:"net error"}}catch(e){}' +
    'try{var hay=(o.title+" "+body.slice(0,3000)).toLowerCase();var sg=' + sigs + ';' +
    'for(var k=0;k<sg.length&&!o.blocker;k++){if(new RegExp(sg[k][1],"i").test(sg[k][0]==="Google"?hay+" "+o.url:hay))o.blocker=sg[k][0]}}catch(e){}' +
    'return JSON.stringify(o)})()'
  )
}

export const PAGE_PROBE_SCRIPT = pageProbeScript()

/**
 * Parse page-probe output. Accepts the raw eval shape (`http`, `live`; CLI
 * double-JSON-encodes it) and the normalized PageProbe shape the server
 * forwards to the tools (`httpStatus`, `liveRegions`) — the browser_open tool
 * re-parses the server's `page` field, and reading only the raw keys there
 * silently dropped the HTTP status (caught driving the built container).
 * Never throws; missing parts default empty.
 */
export function parsePageProbe(stdout: string): PageProbe {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_PROBE
    const p = parsed as Record<string, unknown>
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    const num = (v: unknown): number => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0)
    const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : [])
    return {
      iframes: parseIframeInfo(JSON.stringify(p.iframes ?? [])),
      textChars: num(p.textChars),
      liveRegions: strs(p.live ?? p.liveRegions),
      preview: str(p.preview),
      url: str(p.url),
      title: str(p.title),
      readyState: str(p.readyState),
      httpStatus: num(p.http ?? p.httpStatus),
      contentType: str(p.contentType),
      busy: num(p.busy),
      blocker: str(p.blocker),
      netError: str(p.netError),
    }
  } catch {
    return EMPTY_PROBE
  }
}

/**
 * Warnings the agent must act on before reading the tree: the site did not
 * load, a bot wall is up, the server refused, the document is not a web page,
 * or content is still arriving. Ordered by how completely each one
 * invalidates what follows. Empty for a healthy page.
 */
export function pageWarnings(probe: PageProbe, refCount: number | null, opts: { waitedMs?: number } = {}): string[] {
  const warns: string[] = []
  if (probe.netError) {
    const code = probe.netError === 'net error' ? '' : ` (${probe.netError})`
    warns.push(`site unreachable${code} — this is Chrome's error page, not the site. Check the URL or retry.`)
  }
  if (probe.blocker) {
    warns.push(`bot-block: ${probe.blocker} — the site is challenging automated access. Hand it to the user with request_browser_input; more scraping will not get past it.`)
  }
  if (probe.httpStatus >= 400) {
    const why =
      probe.httpStatus === 401 || probe.httpStatus === 403 ? ' (login or permission required)' :
      probe.httpStatus === 404 ? ' (not found — check the URL)' :
      probe.httpStatus === 429 ? ' (rate limited — slow down or ask the user)' : ''
    warns.push(`HTTP ${probe.httpStatus}${why} — the server refused this page; what follows is the error response, not the content you asked for.`)
  }
  if (probe.contentType && !/html/i.test(probe.contentType)) {
    warns.push(`raw ${probe.contentType} document, not a web page — the tree shows Chrome's viewer. Read the body with fullText:true or browser_eval.`)
  }
  if (probe.readyState && probe.readyState !== 'complete') {
    const waited = opts.waitedMs && opts.waitedMs >= 100 ? ` after waiting ${(opts.waitedMs / 1000).toFixed(1)}s` : ''
    warns.push(`page still ${probe.readyState}${waited} — content may be incomplete. browser_wait for the element you need, then re-snapshot.`)
  }
  if (probe.busy > 0) {
    warns.push(`${probe.busy} loading indicator${probe.busy === 1 ? '' : 's'} visible (aria-busy/progressbar/skeleton) — content still arriving. browser_wait for the element you need, then re-snapshot.`)
  }
  if (refCount === 0 && warns.length === 0) {
    warns.push('no interactive elements — read the page text below before concluding the page is empty; an overlay, a login wall or a plain-text body all look like this.')
  }
  return warns
}

/**
 * The status line every snapshot starts with: where the browser is, what the
 * page calls itself, whether the server said yes, whether it finished loading,
 * and how many refs the tree holds — followed by any warnings. '' when the
 * probe could not run (no URL), so a dead browser does not get a fake header.
 */
export function formatStatusHeader(probe: PageProbe, refCount: number | null, opts: { waitedMs?: number } = {}): string {
  if (!probe.url) return ''
  const facts = [
    probe.url,
    probe.title ? JSON.stringify(probe.title.slice(0, 120)) : 'untitled',
  ]
  if (probe.httpStatus > 0) facts.push(`HTTP ${probe.httpStatus}`)
  if (probe.readyState) facts.push(probe.readyState)
  if (refCount !== null) facts.push(`${refCount} ref${refCount === 1 ? '' : 's'}`)
  const warns = pageWarnings(probe, refCount, opts)
  return `[page] ${facts.join(' · ')}` + warns.map(w => `\n⚠ ${w}`).join('')
}

/** How long a snapshot waits for a loading document before giving up and reporting it as loading. */
export const SNAPSHOT_READY_WAIT_MS = 2000
export const SNAPSHOT_READY_POLL_MS = 150

/**
 * Wait for document.readyState to reach "complete", polling `read` until
 * `timeoutMs`. A snapshot taken right after a navigation (Enter on a search
 * box, a link click) came back as `loading · 0 refs` 7ms later; the header
 * said so, but the agent still paid a round trip to wait and ask again. A
 * read that fails (null) ends the wait — the header will show the truth.
 */
export async function waitForDocumentReady(
  read: () => Promise<string | null>,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<{ readyState: string | null; waitedMs: number }> {
  const timeoutMs = opts.timeoutMs ?? SNAPSHOT_READY_WAIT_MS
  const pollMs = opts.pollMs ?? SNAPSHOT_READY_POLL_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = opts.now ?? (() => Date.now())
  const start = now()
  let readyState = await read()
  while (readyState !== null && readyState !== 'complete' && now() - start < timeoutMs) {
    await sleep(pollMs)
    readyState = await read()
  }
  return { readyState, waitedMs: now() - start }
}

/** Count the refs a rendered tree exposes (`[ref=e12]`, `[level=1, ref=e2]`). */
export function countRefs(tree: string): number {
  return (tree.match(/\bref=e\d+/g) ?? []).length
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

/**
 * Compact a FULL tree (`snapshot` with neither -i nor -c) while keeping its
 * text. agent-browser's own two filters each drop static text: -i skips every
 * node without a ref at render time, and -c keeps only lines containing
 * `ref=` or `: `. So "interactive elements plus the page's text" is not a flag
 * combination the CLI offers — it is this function. Keeps lines that carry a
 * ref, a StaticText node, or a value, plus their ancestors (so an alert's
 * message keeps its `- alert` line and a paragraph keeps its `- paragraph`).
 * Named images are kept for their alt text. Bare structural lines (generic,
 * list, …) with nothing kept beneath them go. Then a prose pass re-joins what
 * the a11y tree splits: an inline wrapper (strong, emphasis, code…) whose only
 * children are text collapses into its parent, whitespace-only text and text
 * that merely repeats a sibling control's name or the parent's value are
 * dropped, and adjacent text siblings merge into one line — so
 * `Your order total is ` / strong / `$42.00` / ` including tax.` reads as one
 * sentence. (Upstream already merges runs that were split without a wrapper.)
 */
export function compactWithText(tree: string): string {
  const lines = tree.split('\n').filter(l => l.trim().length > 0)
  if (lines.length === 0) return tree
  const keep = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const st = staticTextOf(line)
    const isContent =
      line.includes('ref=') ||
      (st !== null && st.trim().length > 0) ||
      /^\s*- image "/.test(line) ||
      line.includes(': ')
    if (!isContent) continue
    keep[i] = true
    let need = indentOf(line)
    for (let j = i - 1; j >= 0 && need > 0; j--) {
      const anc = indentOf(lines[j])
      if (anc < need) {
        keep[j] = true
        need = anc
      }
    }
  }
  const kept = lines.filter((_, i) => keep[i])
  if (kept.length === 0) return tree.trim()
  return joinInlineRuns(kept).join('\n')
}

const INLINE_WRAPPER = /^\s*- (strong|emphasis|code|mark|superscript|subscript|deletion|insertion|time|generic)$/
const STATIC_TEXT = /^(\s*)- StaticText ("(?:[^"\\]|\\.)*")$/
const NAMED_LINE = /^\s*- \S+ ("(?:[^"\\]|\\.)*")/

function indentOf(line: string): number {
  return (line.length - line.replace(/^ */, '').length) >> 1
}

/** The decoded text of a `- StaticText "…"` line, or null for any other line. */
function staticTextOf(line: string): string | null {
  const m = STATIC_TEXT.exec(line)
  if (!m) return null
  try {
    return JSON.parse(m[2]) as string
  } catch {
    return null
  }
}

function staticTextLine(indent: number, text: string): string {
  return `${'  '.repeat(indent)}- StaticText ${JSON.stringify(text)}`
}

function nameOf(line: string): string | null {
  if (staticTextOf(line) !== null) return null
  const m = NAMED_LINE.exec(line)
  if (!m) return null
  try {
    return (JSON.parse(m[1]) as string).trim()
  } catch {
    return null
  }
}

function joinInlineRuns(input: string[]): string[] {
  let lines = input
  // 1. Collapse inline wrappers whose children are all text, until stable (they nest).
  for (let pass = 0; pass < 5; pass++) {
    const out: string[] = []
    let changed = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (INLINE_WRAPPER.test(line)) {
        const depth = indentOf(line)
        let j = i + 1
        while (j < lines.length && indentOf(lines[j]) > depth) j++
        const children = lines.slice(i + 1, j)
        if (children.length > 0 && children.every(c => indentOf(c) === depth + 1 && staticTextOf(c) !== null)) {
          for (const c of children) out.push(c.slice(2))
          i = j - 1
          changed = true
          continue
        }
      }
      out.push(line)
    }
    lines = out
    if (!changed) break
  }
  // 2. Drop text that adds nothing: blank, the parent's value, or a sibling control's name.
  lines = lines.filter((line, i) => {
    const text = staticTextOf(line)
    if (text === null) return true
    const trimmed = text.trim()
    if (trimmed.length === 0) return false
    const depth = indentOf(line)
    for (let j = i - 1; j >= 0; j--) {
      if (indentOf(lines[j]) < depth) {
        if (lines[j].endsWith(`: ${trimmed}`)) return false
        break
      }
    }
    for (const k of [i - 1, i + 1]) {
      if (k >= 0 && k < lines.length && indentOf(lines[k]) === depth && nameOf(lines[k]) === trimmed) return false
    }
    return true
  })
  // 3. Merge adjacent text siblings into one line.
  const merged: string[] = []
  for (const line of lines) {
    const text = staticTextOf(line)
    const prev = merged.length > 0 ? merged[merged.length - 1] : null
    const prevText = prev !== null ? staticTextOf(prev) : null
    if (text !== null && prev !== null && prevText !== null && indentOf(prev) === indentOf(line)) {
      merged[merged.length - 1] = staticTextLine(indentOf(line), prevText + text)
    } else {
      merged.push(line)
    }
  }
  return merged
}

/**
 * Footer for the interactive (default) view: what the page says that the tree
 * above does not. Returns '' in fullText mode (the text is in the tree) and on
 * pages with no meaningful text. Live regions come first — a validation error
 * or toast is usually the reason the agent's last action "did nothing".
 */
export function formatTextFooter(probe: PageProbe, opts: { fullText: boolean; scoped: boolean }): string {
  if (opts.fullText) return ''
  const parts: string[] = []
  if (probe.liveRegions.length > 0) {
    parts.push(`Live regions (alert/status): ${probe.liveRegions.map(s => JSON.stringify(s)).join(' | ')}`)
  }
  if (probe.textChars >= TEXT_FOOTER_MIN_CHARS) {
    const where = opts.scoped ? 'on the page' : 'on this page'
    const preview = probe.preview ? ` Starts: ${JSON.stringify(probe.preview)}` : ''
    parts.push(
      `Page text (~${probe.textChars.toLocaleString('en-US')} chars ${where}) is NOT in this interactive view — prices, prose, errors, table values are all dropped.${preview}\n` +
      `To read it: browser_snapshot with fullText:true (add scope:"<css selector>" to keep it small). Refs are the same in both views.`
    )
  }
  return parts.length > 0 ? `\n\n${parts.join('\n')}` : ''
}
