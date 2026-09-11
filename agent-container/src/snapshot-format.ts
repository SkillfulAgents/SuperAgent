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
 * snapshot (it replaced the iframe-only probe) so the text facts below cost
 * no extra round trip.
 */
export interface PageProbe {
  iframes: IframeInfo[]
  /** Length of the page's visible text (`document.body.innerText`, whitespace-collapsed). */
  textChars: number
  /** Visible text of live regions: role=alert/status, aria-live (not "off"), <output>. */
  liveRegions: string[]
  /** First ~240 chars of <main> (or body) text — the page's gist. */
  preview: string
}

export const EMPTY_PROBE: PageProbe = { iframes: [], textChars: 0, liveRegions: [], preview: '' }

/** Below this much visible text the "text not shown" footer is noise (blank/loading pages). */
export const TEXT_FOOTER_MIN_CHARS = 200
export const PREVIEW_CHARS = 240
const LIVE_REGION_MAX = 8
const LIVE_REGION_CHARS = 300

/**
 * One eval, one JSON object: cross-origin iframes (their fields are invisible
 * to the a11y tree), how much text the page has (the interactive view drops
 * all of it), what the live regions currently say (validation errors, toasts,
 * status lines), and the opening words of <main>. Each part is wrapped in its
 * own try so a hostile page cannot blank the others. Visibility uses
 * getClientRects, not offsetParent — offsetParent is null for position:fixed
 * toasts, which are exactly the live regions we want.
 */
export const PAGE_PROBE_SCRIPT =
  '(function(){var o={iframes:[],textChars:0,live:[],preview:""};' +
  'var ws=function(s){return String(s||"").replace(/\\s+/g," ").trim()};' +
  'try{o.iframes=[...document.querySelectorAll("iframe")].filter(function(f){return f.offsetParent!==null})' +
  '.map(function(f){var host="";try{host=new URL(f.src).host}catch(e){}var same=false;try{same=!!f.contentDocument}catch(e){}' +
  'return{title:f.title||"",host:host,sameOrigin:same}})}catch(e){}' +
  'try{o.textChars=ws(document.body&&document.body.innerText).length}catch(e){}' +
  'try{var seen={};var els=document.querySelectorAll(\'[role="alert"],[role="status"],[aria-live]:not([aria-live="off"]),output\');' +
  'for(var i=0;i<els.length&&o.live.length<' + LIVE_REGION_MAX + ';i++){var el=els[i];if(!el.getClientRects().length)continue;' +
  'var s=ws(el.innerText);if(!s||seen[s])continue;seen[s]=1;o.live.push(s.slice(0,' + LIVE_REGION_CHARS + '))}}catch(e){}' +
  'try{var m=document.querySelector("main,[role=main]")||document.body;o.preview=ws(m&&m.innerText).slice(0,' + PREVIEW_CHARS + ')}catch(e){}' +
  'return JSON.stringify(o)})()'

/** Parse PAGE_PROBE_SCRIPT output (CLI double-JSON-encodes). Never throws; missing parts default empty. */
export function parsePageProbe(stdout: string): PageProbe {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_PROBE
    const p = parsed as Record<string, unknown>
    return {
      iframes: parseIframeInfo(JSON.stringify(p.iframes ?? [])),
      textChars: typeof p.textChars === 'number' && p.textChars > 0 ? Math.floor(p.textChars) : 0,
      liveRegions: Array.isArray(p.live) ? p.live.filter((s): s is string => typeof s === 'string' && s.length > 0) : [],
      preview: typeof p.preview === 'string' ? p.preview : '',
    }
  } catch {
    return EMPTY_PROBE
  }
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
