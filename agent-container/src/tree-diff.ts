/**
 * Tree diff — what an action changed in the accessibility tree, by ref.
 *
 * The page observer (page-observer.ts) says THAT something changed: a dialog
 * opened, +8 interactive elements, a control's state moved. It cannot say
 * what, so the agent used to take a snapshot after nearly every such action
 * just to learn the new refs (transcript-mining themes 3, 6 and 9). When the
 * observer sees a structural change, the server reads the interactive tree
 * once and this module compares it with the last tree the agent was shown
 * (its own snapshot, or the previous action's read), ref by ref.
 *
 * This only works because agent-browser 0.38+ keeps refs: a surviving DOM
 * node keeps its ref across snapshots and an extra snapshot never renumbers
 * the agent's refs (upstream vercel-labs/agent-browser#1443, fixed in 0.38.0;
 * verified on 0.39.1 in our image). Refs are assigned over the whole page
 * regardless of -i/-c/scope, so a ref's line is the same in every mode —
 * the default view and fullText both serve as a baseline.
 *
 * The diff is a fact about two trees, not about the action alone: the
 * baseline can be older than the action (the page may have changed in
 * between), so the header names how old it is.
 */

/** One ref-bearing line of a tree, parsed. */
export interface RefLine {
  ref: string
  /** The line without indentation, the `- ` prefix or a `url=` attribute — what is shown and compared. */
  text: string
  name: string
  /** Bracket attributes other than ref/url, e.g. `checked=false`, `selected`. */
  attrs: string[]
  value: string
  /** The nearest enclosing ref'd line — a select for its options, a listbox for its items. */
  parent: string | null
}

export interface TreeRefs {
  /** Ref → line, in tree order (Map preserves insertion order). */
  lines: Map<string, RefLine>
}

const REF_RE = /\bref=(e\d+)\b/

/** Parse a snapshot tree (any mode) into its ref-bearing lines. Lines without a ref are skipped. */
export function parseTreeRefs(tree: string): TreeRefs {
  const lines = new Map<string, RefLine>()
  // Open ref'd ancestors by indentation, innermost last.
  const stack: Array<{ indent: number; ref: string }> = []
  for (const raw of tree.split('\n')) {
    const indent = raw.length - raw.trimStart().length
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    const body = raw.replace(/^\s*-\s/, '').trim()
    const m = REF_RE.exec(body)
    if (!m || lines.has(m[1])) continue
    lines.set(m[1], parseRefLine(m[1], body, stack.length > 0 ? stack[stack.length - 1].ref : null))
    stack.push({ indent, ref: m[1] })
  }
  return { lines }
}

function parseRefLine(ref: string, body: string, parent: string | null): RefLine {
  // url= is always the last bracket attribute (the CLI pushes it after ref=);
  // includeUrls is a display choice, not a change.
  const text = body.replace(/, url=[^\]]*\]/, ']').replace(/\[url=[^\]]*\]\s?/, '')
  const nameMatch = /^\S+ ("(?:[^"\\]|\\.)*")/.exec(text)
  let name = ''
  if (nameMatch) {
    try { name = JSON.parse(nameMatch[1]) as string } catch { name = nameMatch[1] }
  }
  const bracket = /\[([^\]]*\bref=e\d+[^\]]*)\]/.exec(text)
  const attrs = bracket
    ? bracket[1].split(',').map(a => a.trim()).filter(a => a && !a.startsWith('ref='))
    : []
  // The value follows the attributes (and any cursor hints) as `: value`.
  const after = bracket ? text.slice(bracket.index + bracket[0].length) : ''
  const colon = after.indexOf(': ')
  const value = colon >= 0 ? after.slice(colon + 2) : ''
  return { ref, text, name, attrs, value, parent }
}

/** True when `ref` is one of `roots` or nested under one of them in `tree`. */
function within(tree: TreeRefs, ref: string, roots: Set<string>): boolean {
  let cur: string | null = ref
  for (let guard = 0; cur && guard < 64; guard++) {
    if (roots.has(cur)) return true
    cur = tree.lines.get(cur)?.parent ?? null
  }
  return false
}

export interface ChangedRef {
  line: RefLine
  /** What it was, e.g. `checked=false` or `value "Pick"`. */
  was: string
}

export interface TreeDiff {
  added: RefLine[]
  /**
   * Refs that were absent from the baseline but are back exactly as the agent
   * last saw them on this page — the page behind a modal dialog that just
   * closed. Reported as a count: the agent already has their lines.
   */
  returned: RefLine[]
  changed: ChangedRef[]
  removed: RefLine[]
}

export function treeDiffIsEmpty(d: TreeDiff): boolean {
  return d.added.length === 0 && d.returned.length === 0 && d.changed.length === 0 && d.removed.length === 0
}

/** What `before` was, in the terms that differ from `after`. */
function describeWas(before: RefLine, after: RefLine): string {
  const parts: string[] = []
  if (before.name !== after.name && before.name && after.name) parts.push(`name ${JSON.stringify(clip(before.name, 40))}`)
  const key = (a: string): string => a.split('=')[0]
  const afterKeys = new Map(after.attrs.map(a => [key(a), a]))
  const beforeKeys = new Map(before.attrs.map(a => [key(a), a]))
  // key=value attributes say what they were; a flag that went away was set,
  // one that appeared was not.
  for (const [k, a] of beforeKeys) {
    if (afterKeys.get(k) !== a) parts.push(a)
  }
  for (const [k, a] of afterKeys) {
    if (!beforeKeys.has(k)) parts.push(a.includes('=') ? `no ${k}` : `not ${a}`)
  }
  if (before.value !== after.value) parts.push(before.value ? `value ${JSON.stringify(clip(before.value, 40))}` : 'empty')
  return parts.join(', ')
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** A masked password value as the tree prints it. */
const MASKED = /^•+$/

export interface DiffOptions {
  /**
   * Refs left out, with everything nested under them: the target of a fill
   * or select, whose new value (and a select's options) the result already
   * reports.
   */
  excludeRefs?: Iterable<string>
  /** Lines the agent has seen earlier on this page (see TreeBaseline.seen). */
  seen?: ReadonlyMap<string, string>
  /**
   * Values the agent was told after the baseline was taken (fill/type/select
   * read-backs), by ref: a later diff does not report those as changes. null
   * stands for "anything" (a select, whose tree value is the label while the
   * read-back is the option value).
   */
  acknowledged?: ReadonlyMap<string, string | null>
}

/**
 * Compare two trees by ref. A ref whose line differs only in its name, where
 * one side has no name, is not a change: the interactive view falls back to a
 * cursor-interactive element's text for its name and the full view does not.
 */
export function diffTrees(before: TreeRefs, after: TreeRefs, opts: DiffOptions = {}): TreeDiff {
  const roots = new Set([...(opts.excludeRefs ?? [])].map(r => r.replace(/^@/, '')))
  const excluded = (ref: string): boolean => roots.size > 0 && (within(after, ref, roots) || within(before, ref, roots))
  const ack = opts.acknowledged ?? new Map<string, string | null>()
  const ackRoots = new Set(ack.keys())
  const acknowledgedChange = (line: RefLine): boolean => {
    if (ack.size === 0 || !within(after, line.ref, ackRoots)) return false
    if (!ack.has(line.ref)) return true // nested under an acknowledged control: a select's options
    const v = ack.get(line.ref)
    return v === null || v === undefined || line.value === v || MASKED.test(line.value)
  }
  const added: RefLine[] = []
  const returned: RefLine[] = []
  const changed: ChangedRef[] = []
  const removed: RefLine[] = []
  for (const [ref, line] of after.lines) {
    if (excluded(ref)) continue
    const prev = before.lines.get(ref)
    if (!prev) {
      if (opts.seen?.get(ref) === line.text) returned.push(line)
      else added.push(line)
      continue
    }
    if (prev.text === line.text) continue
    const sameButName = prev.attrs.join(',') === line.attrs.join(',') && prev.value === line.value && (!prev.name || !line.name)
    if (sameButName || acknowledgedChange(line)) continue
    changed.push({ line, was: describeWas(prev, line) })
  }
  for (const [ref, line] of before.lines) {
    if (!excluded(ref) && !after.lines.has(ref)) removed.push(line)
  }
  return { added, returned, changed, removed }
}

/** Lines shown before the rest is summarised as a count. */
export const TREE_DIFF_MAX_LINES = 25
/** Removed elements are the least actionable: a few lines, then a count. */
export const TREE_DIFF_MAX_REMOVED_LINES = 6
const LINE_CHARS = 200

function ageText(ms: number): string {
  if (ms < 1000) return 'just now'
  const s = Math.round(ms / 1000)
  return s < 120 ? `${s}s ago` : `${Math.round(s / 60)} min ago`
}

export interface TreeDiffFormatOptions {
  /** How long before the read the baseline was taken. */
  baselineAgeMs: number
  /** Where the baseline came from: the agent's own snapshot, or the tree read after an earlier action. */
  baselineSource: 'snapshot' | 'action'
  /**
   * A dialog opened with this action: the elements that left the tree are
   * reported as one count. A modal dialog takes the rest of the page out of
   * the accessibility tree while it is open; listing all of it as "removed"
   * reads as if the page had been torn down.
   */
  dialogOpened?: boolean
  maxLines?: number
}

/**
 * The diff as lines under the Effect line: added first (new things to act
 * on), then changed, then removed — capped so a page swap cannot flood the
 * result. Every line carries its ref, so the agent can act on it without
 * another snapshot.
 */
export function formatTreeDiff(d: TreeDiff, opts: TreeDiffFormatOptions): string {
  if (treeDiffIsEmpty(d)) return ''
  const max = opts.maxLines ?? TREE_DIFF_MAX_LINES
  const since = opts.baselineSource === 'snapshot' ? `your snapshot ${ageText(opts.baselineAgeMs)}` : `the previous action's tree ${ageText(opts.baselineAgeMs)}`
  const counts = [
    d.added.length > 0 ? `${d.added.length} added` : '',
    d.returned.length > 0 ? `${d.returned.length} back` : '',
    d.changed.length > 0 ? `${d.changed.length} changed` : '',
    d.removed.length > 0 ? `${d.removed.length} removed` : '',
  ].filter(Boolean).join(', ')
  const main: string[] = [
    ...d.added.map(l => `+ ${clip(l.text, LINE_CHARS)}`),
    ...d.changed.map(c => `~ ${clip(c.line.text, LINE_CHARS)}${c.was ? ` (was ${c.was})` : ''}`),
  ]
  const removedShown = opts.dialogOpened ? 0 : Math.min(d.removed.length, TREE_DIFF_MAX_REMOVED_LINES)
  const mainShown = main.slice(0, Math.max(0, max - removedShown))
  const lines = [...mainShown]
  if (main.length > mainShown.length) lines.push(`… ${main.length - mainShown.length} more added/changed not shown`)
  if (d.returned.length > 0) {
    lines.push(`+ ${d.returned.length} element${d.returned.length === 1 ? '' : 's'} back in the tree exactly as you last saw ${d.returned.length === 1 ? 'it' : 'them'}, same refs`)
  }
  lines.push(...d.removed.slice(0, removedShown).map(l => `− ${clip(l.text, LINE_CHARS)}`))
  const removedHidden = d.removed.length - removedShown
  if (removedHidden > 0) {
    lines.push(opts.dialogOpened
      ? `− ${removedHidden} other element${removedHidden === 1 ? ' is' : 's are'} not in the tree while the dialog is open`
      : `− ${removedHidden} more no longer in the tree`)
  }
  return `\nTree changes since ${since} (${counts}):\n${lines.join('\n')}`
}

/**
 * The last tree the agent was shown, kept so the next action can be diffed
 * against it. One per browser — the active tab's — and only for the page it
 * was read on: a different URL means a different document whose refs are not
 * comparable.
 */
export interface TreeBaseline {
  url: string
  refs: TreeRefs
  takenAt: number
  source: 'snapshot' | 'action'
  /** Every ref line the agent has been shown on this page, latest text — to tell "back" from "added". */
  seen: Map<string, string>
  /** Read-back values since this tree was read (DiffOptions.acknowledged). */
  acknowledged: Map<string, string | null>
}

let baseline: TreeBaseline | null = null

/** Cap on remembered lines per page — a long infinite scroll must not grow without bound. */
const SEEN_MAX = 20_000

export function setTreeBaseline(url: string, tree: string, source: TreeBaseline['source'], now = Date.now()): void {
  if (!url) { baseline = null; return }
  const refs = parseTreeRefs(tree)
  // A copy: a caller may still be diffing against the previous baseline's map.
  const seen = baseline && baseline.url === url ? new Map(baseline.seen) : new Map<string, string>()
  for (const [ref, line] of refs.lines) {
    seen.delete(ref)
    seen.set(ref, line.text)
  }
  while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string)
  baseline = { url, refs, takenAt: now, source, seen, acknowledged: new Map() }
}

/** The baseline for `url`, or null when there is none for that page. */
export function getTreeBaseline(url: string): TreeBaseline | null {
  return baseline && baseline.url === url ? baseline : null
}

/** The agent was told `ref`'s value (null: told it changed, value not comparable). */
export function acknowledgeTreeValue(url: string, ref: string, value: string | null): void {
  const b = getTreeBaseline(url)
  if (b) b.acknowledged.set(ref.replace(/^@/, ''), value)
}

export function resetTreeBaseline(): void {
  baseline = null
}
