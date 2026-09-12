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

/** An `Iframe` node in the CLI's tree: its accessible name and whether it has children. */
function treeIframes(tree: string): Array<{ title: string; hasChildren: boolean }> {
  const lines = tree.split('\n')
  const out: Array<{ title: string; hasChildren: boolean }> = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)- iframe(?: "((?:[^"\\]|\\.)*)")?/i.exec(lines[i])
    if (!m) continue
    const indent = m[1].length
    let hasChildren = false
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue
      const childIndent = (/^(\s*)/.exec(lines[j]) ?? ['', ''])[1].length
      hasChildren = childIndent > indent
      break
    }
    out.push({ title: (m[2] ?? '').trim(), hasChildren })
  }
  return out
}

/**
 * List the visible iframes whose contents the tree does NOT carry.
 *
 * The CLI merges frames — cross-origin ones included — into the tree with
 * working refs (verified on agent-browser 0.27.2: a card field inside a
 * cross-origin frame fills and reads back by ref). The old footer listed
 * every cross-origin frame as "contents NOT in this snapshot" directly under
 * that frame's own refs, then prescribed a coordinate click that has no CLI
 * command; agents believed the prose over the tree (mining theme 11). Now a
 * frame is listed only when the tree has no `Iframe` node with that name
 * carrying children — i.e. when the tree really could not read it — and the
 * line states that and nothing else.
 */
export function formatIframePlaceholders(iframes: IframeInfo[], tree = ''): string {
  const inTree = treeIframes(tree)
  const unreadable = iframes.filter(f => {
    if (!f.host) return false
    const title = f.title.trim()
    const matches = inTree.filter(t => t.title === title)
    if (matches.length === 0) return true
    // An untitled DOM frame with any untitled tree frame carrying children
    // is taken as merged; a titled frame must match by name.
    return !matches.some(t => t.hasChildren)
  })
  if (unreadable.length === 0) return ''
  const lines = unreadable.map(f => {
    const label = f.title ? `"${f.title}" ` : ''
    const origin = f.sameOrigin ? '' : ' · cross-origin'
    return `  - iframe ${label}(${f.host})${origin}`
  })
  return `\n\nFrames on this page whose contents are not in this tree:\n${lines.join('\n')}`
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
 * children are text collapses into its parent, text that merely repeats a
 * sibling control's name or the parent's value is dropped, and adjacent text
 * siblings merge into one line exactly as the page has them — the whitespace
 * between inline elements is its own node and is kept — so `Your order total
 * is ` / strong / `$42.00` / ` including tax.` reads as one sentence.
 * (Upstream already merges runs that were split without a wrapper.)
 */
export function compactWithText(tree: string): string {
  const lines = logicalLines(tree)
  if (lines.length === 0) return tree
  const keep = new Array<boolean>(lines.length).fill(false)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const st = staticTextOf(line)
    const isContent =
      line.includes('ref=') ||
      (st !== null && (st.trim().length > 0 || isProseWhitespace(lines, i))) ||
      /^\s*- image "/.test(line) ||
      LINE_BREAK.test(line) ||
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

/**
 * The tree's lines, with a multi-line value kept on its node: a textarea's
 * `textbox "Notes" [ref=e3]: line one⏎line two` renders with raw newlines, and
 * a line that does not start a node is the continuation of the one before it.
 * Splitting naively made "line two" a nameless line that the filter dropped
 * and "line three" an "ancestor" it kept.
 */
function logicalLines(tree: string): string[] {
  const out: string[] = []
  for (const raw of tree.split('\n')) {
    if (/^\s*- /.test(raw) || out.length === 0) {
      if (raw.trim().length > 0) out.push(raw)
    } else {
      out[out.length - 1] += `\n${raw}`
    }
  }
  return out
}

const INLINE_WRAPPER = /^\s*- (strong|emphasis|code|mark|superscript|subscript|deletion|insertion|time|generic)$/
const LINE_BREAK = /^(\s*)- LineBreak\b/

/**
 * A whitespace-only text node is prose when it sits between two inline
 * siblings — the space in `<code>rm</code> <code>-rf</code>` is its own node
 * in the tree, and the only record of the space. It is kept when a sibling
 * at the same depth (skipping deeper lines) is content or an inline wrapper;
 * a lone blank text under an empty container is not.
 */
function isProseWhitespace(lines: string[], i: number): boolean {
  const depth = indentOf(lines[i])
  const contentLike = (line: string): boolean => {
    const st = staticTextOf(line)
    return line.includes('ref=') || (st !== null && st.trim().length > 0) || INLINE_WRAPPER.test(line) || LINE_BREAK.test(line)
  }
  let found = false
  for (let j = i - 1; j >= 0 && !found; j--) {
    const d = indentOf(lines[j])
    if (d < depth) break
    if (d === depth) { found = contentLike(lines[j]); break }
  }
  for (let j = i + 1; j < lines.length && !found; j++) {
    const d = indentOf(lines[j])
    if (d < depth) break
    if (d === depth) { found = contentLike(lines[j]); break }
  }
  return found
}
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

/** Drop text that adds nothing: the parent's value, or a sibling control's name. */
function dropsRedundantText(lines: string[]): string[] {
  return lines.filter((line, i) => {
    const text = staticTextOf(line)
    if (text === null) return true
    const trimmed = text.trim()
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
}

function joinInlineRuns(input: string[]): string[] {
  // 0. A line break inside prose (a textarea's value, a <br>) is text that
  // says "\n" — kept through the merge so the lines stay lines.
  let lines = input.map(line => {
    const m = LINE_BREAK.exec(line)
    return m ? staticTextLine(m[1].length >> 1, '\n') : line
  })
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
  // 2. Drop text that adds nothing: the parent's value, or a sibling
  // control's name. Whitespace-only runs stay: they are the spaces between
  // inline elements and are merged exactly in the next step.
  lines = dropsRedundantText(lines)
  // 3. Merge adjacent text siblings into one line, exactly as the page has
  // them: the tree splits prose at element boundaries and keeps the whitespace
  // between elements as its own node, so `Never` + ` ` + `delete` is "Never
  // delete" and `example.` + `com` is "example.com" — nothing is guessed.
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
  // 4. A merged run can now equal the parent's value (a textarea's lines
  // re-joined) — drop it the same way; and a run that is only whitespace.
  return dropsRedundantText(merged).filter(line => {
    const text = staticTextOf(line)
    return text === null || text.trim().length > 0
  })
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
