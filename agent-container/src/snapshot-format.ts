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
 *
 * The page facts a snapshot carries (status line, text footer) come from the
 * page observer (page-observer.ts) and are rendered by page-status.ts and
 * formatTextFooter below.
 */
import type { IframeInfo, PageObservation } from './page-observer'

/**
 * Auto-degrade threshold. The SDK tool-result token cap (~25k tokens) fires
 * around 62–74k chars of token-dense a11y text — nondeterministically at the
 * edge. Truncate well below that so a snapshot never hard-errors mid-flow.
 */
export const SNAPSHOT_SOFT_CAP_CHARS = 45_000

/** Below this much visible text the "text not shown" footer is noise (blank/loading pages). */
export const TEXT_FOOTER_MIN_CHARS = 200
/** A tree with fewer refs than this gets the long text preview — the text is all the agent has. */
export const THIN_TREE_REFS = 5

export type { IframeInfo }

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

/** Count the refs a rendered tree exposes (`[ref=e12]`, `[level=1, ref=e2]`). */
export function countRefs(tree: string): number {
  return (tree.match(/\bref=e\d+/g) ?? []).length
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
 * `previewChars` trims the observer's preview to what this view should show.
 */
export function formatTextFooter(obs: PageObservation, opts: { fullText: boolean; scoped: boolean; previewChars?: number }): string {
  if (opts.fullText) return ''
  const parts: string[] = []
  if (obs.liveRegions.length > 0) {
    parts.push(`Live regions (alert/status): ${obs.liveRegions.map(s => JSON.stringify(s)).join(' | ')}`)
  }
  if (obs.textChars >= TEXT_FOOTER_MIN_CHARS) {
    const where = opts.scoped ? 'on the page' : 'on this page'
    const previewText = opts.previewChars !== undefined ? obs.preview.slice(0, opts.previewChars) : obs.preview
    const preview = previewText ? ` Starts: ${JSON.stringify(previewText)}` : ''
    parts.push(
      `Page text (~${obs.textChars.toLocaleString('en-US')} chars ${where}) is NOT in this interactive view — prices, prose, errors, table values are all dropped.${preview}\n` +
      `To read it: browser_snapshot with fullText:true (add scope:"<css selector>" to keep it small). Refs are the same in both views.`
    )
  }
  return parts.length > 0 ? `\n\n${parts.join('\n')}` : ''
}
