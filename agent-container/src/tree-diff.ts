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
  /**
   * An element that left the tree paired with one that arrived with exactly
   * the same line but a new ref — the site re-rendered it (a framework
   * replacing the DOM after a modal closes, a list re-drawn). Its old ref no
   * longer works, which is the one thing about it worth saying.
   */
  rerendered: Array<{ from: RefLine; to: RefLine }>
  changed: ChangedRef[]
  removed: RefLine[]
  /**
   * A menu or listbox that was not in the baseline arrived ('menu' or
   * 'listbox'), else ''. Options that change inside a list already open are
   * not a popup appearing.
   */
  popup?: string
}

export function treeDiffIsEmpty(d: TreeDiff): boolean {
  return d.added.length === 0 && d.returned.length === 0 && d.rerendered.length === 0 && d.changed.length === 0 && d.removed.length === 0
}

/** A line without its ref: what an element "is", independent of the ref it was given. */
export function lineWithoutRef(text: string): string {
  return text.replace(/\[ref=e\d+\]\s?/, '').replace(/,? ?\bref=e\d+/, '').replace(/\[\]/, '').replace(/\s+/g, ' ').trim()
}

/** What `before` was, in the terms that differ from `after`. */
function describeWas(before: RefLine, after: RefLine): string {
  const parts: string[] = []
  if (before.name !== after.name && before.name && after.name) parts.push(`name was ${JSON.stringify(clipAround(before.name, after.name, 40))}`)
  const key = (a: string): string => a.split('=')[0]
  const afterKeys = new Map(after.attrs.map(a => [key(a), a]))
  const beforeKeys = new Map(before.attrs.map(a => [key(a), a]))
  // Each change as a transition, so "(was selected)" cannot be read either way.
  const val = (a: string | undefined): string => (a === undefined ? 'unset' : a.includes('=') ? a.slice(a.indexOf('=') + 1) : a)
  for (const [k, a] of beforeKeys) {
    const now = afterKeys.get(k)
    if (now === a) continue
    if (!a.includes('=')) parts.push(`no longer ${a}`)
    else parts.push(`${k}: ${val(a)} → ${val(now)}`)
  }
  for (const [k, a] of afterKeys) {
    if (beforeKeys.has(k)) continue
    parts.push(a.includes('=') ? `${k}: unset → ${val(a)}` : `now ${a}`)
  }
  if (before.value !== after.value) parts.push(`value ${before.value ? JSON.stringify(clipAround(before.value, after.value, 40)) : 'empty'} → ${after.value ? JSON.stringify(clipAround(after.value, before.value, 40)) : 'empty'}`)
  return parts.join(', ')
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/**
 * `s` in at most `n` characters, showing where it differs from `other`: two
 * long names that share their first 40 characters ("Add to cart — Product A…"
 * and "… B") would otherwise clip to the same text.
 */
function clipAround(s: string, other: string, n: number): string {
  if (s.length <= n) return s
  let i = 0
  while (i < s.length && i < other.length && s[i] === other[i]) i++
  if (i < n - 8) return clip(s, n)
  const start = Math.max(0, i - 12)
  const tail = s.length - start > n - 1
  return `…${s.slice(start, start + n - (tail ? 2 : 1))}${tail ? '…' : ''}`
}

/** A masked password value as the tree prints it. */
const MASKED = /^•+$/

export interface DiffOptions {
  /**
   * Refs left out: the target of a fill or type, whose value the result
   * already reports. Only the target's own line — an ARIA combobox owns its
   * suggestion listbox in the tree, and those suggestions are the effect
   * (W3C APG combobox: typing "New" hid the filtered list).
   */
  excludeRefs?: Iterable<string>
  /** Refs left out with everything nested under them: a native select and its options. */
  excludeSubtrees?: Iterable<string>
  /**
   * A dialog opened with the action: what left the tree is behind it, not
   * re-rendered — a dialog's own "Close" or "Departure" field is not the
   * page's (bench: Google Flights, Hotels, Maps).
   */
  overlayOpened?: boolean
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
  const exact = new Set([...(opts.excludeRefs ?? [])].map(r => r.replace(/^@/, '')))
  const roots = new Set([...(opts.excludeSubtrees ?? [])].map(r => r.replace(/^@/, '')))
  const excluded = (ref: string): boolean =>
    exact.has(ref) || (roots.size > 0 && (within(after, ref, roots) || within(before, ref, roots)))
  const ack = opts.acknowledged ?? new Map<string, string | null>()
  // A read-back value covers the field's own line; a select (null) covers its options too.
  const ackRoots = new Set([...ack].filter(([, v]) => v === null).map(([k]) => k))
  const acknowledgedChange = (line: RefLine): boolean => {
    if (ack.size === 0) return false
    if (ack.has(line.ref)) {
      const v = ack.get(line.ref)
      return v === null || v === undefined || line.value === v || MASKED.test(line.value)
    }
    return ackRoots.size > 0 && within(after, line.ref, ackRoots)
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
  // Pair what left with what arrived looking exactly the same: one element
  // re-rendered under a new ref, not one removed and one added. Looking the
  // same is not enough on its own — a calendar's "1" of October and of
  // November, two laptops whose names the site cut to the same 16 characters,
  // each with its own "Add to cart" (live review) — so a pair needs an
  // anchor:
  //  - a line whose name (with a letter in it) is unique on both sides pairs
  //    when its enclosing lines and both neighbours are the same lines;
  //  - failing that, a line pairs when a neighbour is itself a pair, its
  //    enclosing lines match and the run of identical lines it stands in is
  //    as long on both sides (a re-drawn region, element by element — not 3
  //    rows that replaced 10; a list re-drawn with one item appended);
  //  - a name of only digits ("1", "2": a day, a page number) never anchors.
  // When everything that left came back identical, the order alone pairs them.
  const keyOf = (l: RefLine): string => lineWithoutRef(l.text)
  const arrivals = new Map<string, RefLine[]>()
  for (const l of added) arrivals.set(keyOf(l), [...(arrivals.get(keyOf(l)) ?? []), l])
  const departures = new Map<string, number>()
  for (const l of removed) departures.set(keyOf(l), (departures.get(keyOf(l)) ?? 0) + 1)
  let matches = 0
  for (const [k, n] of departures) matches += Math.min(n, arrivals.get(k)?.length ?? 0)
  const total = removed.length > 0 && matches === removed.length && matches === added.length
  const beforeOrder = [...before.lines.values()]
  const afterOrder = [...after.lines.values()]
  const beforePos = new Map(beforeOrder.map((l, i) => [l.ref, i]))
  const afterPos = new Map(afterOrder.map((l, i) => [l.ref, i]))
  const neighbour = (order: RefLine[], pos: Map<string, number>, l: RefLine, d: number): RefLine | undefined => {
    const i = pos.get(l.ref)
    return i === undefined ? undefined : order[i + d]
  }
  const ancestry = (tree: TreeRefs, l: RefLine): string => {
    const keys: string[] = []
    let p = l.parent
    for (let guard = 0; p && guard < 8; guard++) {
      const pl = tree.lines.get(p)
      if (!pl) break
      keys.push(keyOf(pl))
      p = pl.parent
    }
    return keys.join(' > ')
  }
  // Unique in the whole tree on each side, not only among what moved: with
  // ten "disclaimer *" buttons staying put, the one that left is not identified.
  const countIn = (order: RefLine[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const l of order) m.set(keyOf(l), (m.get(keyOf(l)) ?? 0) + 1)
    return m
  }
  const beforeCount = countIn([...before.lines.values()])
  const afterCount = countIn([...after.lines.values()])
  const identifying = (l: RefLine): boolean =>
    /\p{L}/u.test(l.name) && beforeCount.get(keyOf(l)) === 1 && afterCount.get(keyOf(l)) === 1
  const digitsOnly = (l: RefLine): boolean => l.name !== '' && !/\p{L}/u.test(l.name)
  // How many lines in a row, around `l`, read exactly like it.
  const run = (order: RefLine[], pos: Map<string, number>, l: RefLine): number => {
    const i = pos.get(l.ref) ?? 0
    let a = i, b = i
    while (a > 0 && keyOf(order[a - 1]) === keyOf(l)) a--
    while (b < order.length - 1 && keyOf(order[b + 1]) === keyOf(l)) b++
    return b - a + 1
  }
  const pairOf = new Map<string, RefLine>()
  const taken = new Set<RefLine>()
  const sameKey = (a: RefLine | undefined, b: RefLine | undefined): boolean => (a ? keyOf(a) : '') === (b ? keyOf(b) : '')
  const isPair = (a: RefLine | undefined, b: RefLine | undefined): boolean => Boolean(a && b && pairOf.get(a.ref) === b)
  const tryPair = (l: RefLine, ok: (to: RefLine) => boolean): void => {
    const to = (arrivals.get(keyOf(l)) ?? []).find(a => !taken.has(a) && ok(a))
    if (to) { pairOf.set(l.ref, to); taken.add(to) }
  }
  if (opts.overlayOpened) {
    // No pairs: the page is behind the dialog.
  } else if (total) {
    for (const l of removed) tryPair(l, () => true)
  } else {
    for (const l of removed) {
      if (!identifying(l)) continue
      tryPair(l, to => ancestry(before, l) === ancestry(after, to) &&
        sameKey(neighbour(beforeOrder, beforePos, l, -1), neighbour(afterOrder, afterPos, to, -1)) &&
        sameKey(neighbour(beforeOrder, beforePos, l, 1), neighbour(afterOrder, afterPos, to, 1)))
    }
    for (let round = 0, grew = true; grew && round < 50; round++) {
      grew = false
      for (const l of removed) {
        if (pairOf.has(l.ref) || digitsOnly(l)) continue
        tryPair(l, to => ancestry(before, l) === ancestry(after, to) &&
          run(beforeOrder, beforePos, l) === run(afterOrder, afterPos, to) && (
          isPair(neighbour(beforeOrder, beforePos, l, -1), neighbour(afterOrder, afterPos, to, -1)) ||
          isPair(neighbour(beforeOrder, beforePos, l, 1), neighbour(afterOrder, afterPos, to, 1))))
        if (pairOf.has(l.ref)) grew = true
      }
    }
  }
  const rerendered: Array<{ from: RefLine; to: RefLine }> = []
  const stillRemoved: RefLine[] = []
  for (const l of removed) {
    const to = pairOf.get(l.ref)
    if (to) rerendered.push({ from: l, to }); else stillRemoved.push(l)
  }
  const paired = new Set(rerendered.map(r => r.to))
  // A menu, or a listbox, that was not there before: options changing in a
  // list already open are not one appearing (GitHub's branch filter), and a
  // suggestion list open elsewhere does not hide a menu that just opened.
  const MENU = /^(menu|menuitem|menuitemcheckbox|menuitemradio)\b/
  const LIST = /^(listbox|option)\b/
  const had = (re: RegExp): boolean => [...before.lines.values()].some(l => re.test(l.text))
  const popup = added.some(l => MENU.test(l.text)) && !had(MENU) ? 'menu'
    : added.some(l => /^listbox\b/.test(l.text)) || (added.some(l => LIST.test(l.text)) && !had(LIST)) ? 'listbox' : ''
  return { added: added.filter(l => !paired.has(l)), returned, rerendered, changed, removed: stillRemoved, popup }
}

/** Lines shown before the rest is summarised as a count. */
export const TREE_DIFF_MAX_LINES = 25
/** Removed elements are the least actionable: a few lines, then a count. */
export const TREE_DIFF_MAX_REMOVED_LINES = 6
/** Re-rendered elements: enough old → new pairs to keep acting, then a count. */
export const TREE_DIFF_MAX_RERENDER_LINES = 6
/** A line leaving and arriving at least this many times is summarised in one line. */
export const TREE_DIFF_CHURN_MIN = 3
/** Elements back in the tree are listed up to this many, then counted. */
export const TREE_DIFF_MAX_BACK_LINES = 5
/** Changed lines listed ahead of the added ones; the rest follow them. */
export const TREE_DIFF_LEADING_CHANGED_LINES = 8
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
 * The diff as lines under the Effect line: re-rendered refs, changed, added
 * (new things to act on), then removed — capped so a page swap cannot flood the
 * result. Every line carries its ref, so the agent can act on it without
 * another snapshot.
 */
export function formatTreeDiff(d: TreeDiff, opts: TreeDiffFormatOptions): string {
  if (treeDiffIsEmpty(d)) return ''
  const max = opts.maxLines ?? TREE_DIFF_MAX_LINES
  const since = opts.baselineSource === 'snapshot' ? `your snapshot ${ageText(opts.baselineAgeMs)}` : `the previous action's tree ${ageText(opts.baselineAgeMs)}`
  // A parent that adds nothing but a wrapper — its one child has the same
  // name (a calendar gridcell around its button) — is listed through the child.
  const addedRefs = new Set(d.added.map(l => l.ref))
  // Not when the parent carries state or the child is a generic box (an
  // option [selected] around its text: the option is the line to keep).
  const wrappers = new Set(d.added.filter(l => {
    const parent = l.parent && addedRefs.has(l.parent) ? d.added.find(p => p.ref === l.parent) : undefined
    return parent !== undefined && l.name !== '' && parent.name === l.name && parent.attrs.length === 0 && !/^generic\b/.test(l.text)
  }).map(l => l.parent as string))
  const addedCount = d.added.length - wrappers.size
  const counts = [
    d.rerendered.length > 0 ? `${d.rerendered.length} replaced by identical lines` : '',
    addedCount > 0 ? `${addedCount} added` : '',
    d.returned.length > 0 ? `${d.returned.length} back` : '',
    d.changed.length > 0 ? `${d.changed.length} changed` : '',
    d.removed.length > 0 ? `${d.removed.length} removed` : '',
  ].filter(Boolean).join(', ')
  // Changed lines first: they are mostly the controls the agent just acted
  // on, and a results list arriving with them must not push them out of the cap.
  const changedLines = d.changed.map(c => `~ ${clip(c.line.text, LINE_CHARS)}${c.was ? ` (${c.was})` : ''}`)
  // Inside a dialog that arrived: listed before anything else that arrived
  // (Airbnb: late result prices pushed the new filter dialog's radios out).
  const addedByRef = new Map(d.added.map(l => [l.ref, l]))
  const inNewDialog = (l: RefLine): boolean => {
    for (let p: RefLine | undefined = l, guard = 0; p && guard < 32; p = p.parent ? addedByRef.get(p.parent) : undefined, guard++) {
      if (/^(dialog|alertdialog)\b/.test(p.text)) return true
    }
    return false
  }
  // The same line leaving and arriving many times over (Toyota: 18 ×
  // "disclaimer *" whose surroundings changed): one line each, so what else
  // left or arrived is not buried under them.
  const keyCount = (ls: RefLine[]): Map<string, RefLine[]> => {
    const m = new Map<string, RefLine[]>()
    for (const l of ls) m.set(lineWithoutRef(l.text), [...(m.get(lineWithoutRef(l.text)) ?? []), l])
    return m
  }
  const arrivedBy = keyCount(d.added.filter(l => !wrappers.has(l.ref)))
  const leftBy = keyCount(d.removed)
  const churn = [...arrivedBy.keys()].filter(k => (arrivedBy.get(k)?.length ?? 0) >= TREE_DIFF_CHURN_MIN && (leftBy.get(k)?.length ?? 0) >= TREE_DIFF_CHURN_MIN)
  const churned = new Set(churn)
  const churnLines = churn.map(k => {
    const came = arrivedBy.get(k) ?? []
    const refs = came.slice(0, 8).map(l => l.ref).join(', ')
    return `± ${clip(k, 120)}: ${leftBy.get(k)?.length ?? 0} left the tree, ${came.length} arrived (${refs}${came.length > 8 ? ', …' : ''})`
  })
  const shownAdded = d.added.filter(l => !wrappers.has(l.ref) && !churned.has(lineWithoutRef(l.text)))
  const ordered = [...shownAdded.filter(inNewDialog), ...shownAdded.filter(l => !inNewDialog(l))]
  const main: string[] = [
    ...changedLines.slice(0, TREE_DIFF_LEADING_CHANGED_LINES),
    ...ordered.map(l => `+ ${clip(l.text, LINE_CHARS)}`),
    ...churnLines,
    ...changedLines.slice(TREE_DIFF_LEADING_CHANGED_LINES),
  ]
  const removedList = d.removed.filter(l => !churned.has(lineWithoutRef(l.text)))
  // A menu or listbox that arrived while many elements left: a modal menu
  // (Radix and others) takes the page out of the tree like a dialog does.
  const popup = opts.dialogOpened ? '' : d.popup ?? ''
  const collapse = opts.dialogOpened || (popup !== '' && removedList.length > TREE_DIFF_MAX_REMOVED_LINES)
  const removedShown = collapse ? 0 : Math.min(removedList.length, TREE_DIFF_MAX_REMOVED_LINES)
  // First: refs that stopped working. Acting on one of them is the failure
  // this prevents (✗ Unknown ref after a site re-drew the page).
  const lines: string[] = []
  if (d.rerendered.length > 0) {
    const one = d.rerendered.length === 1
    lines.push(`⟳ ${d.rerendered.length} line${one ? ' was' : 's were'} replaced by ${one ? 'an identical line' : 'identical lines'} in the same place, under ${one ? 'a new ref' : 'new refs'}; the old ref${one ? '' : 's'} no longer work${one ? 's' : ''}:`)
    const shown = d.rerendered.slice(0, TREE_DIFF_MAX_RERENDER_LINES)
    lines.push(...shown.map(r => `  ${clip(lineWithoutRef(r.to.text), 120)}: ${r.from.ref} → ${r.to.ref}`))
    if (d.rerendered.length > shown.length) lines.push(`  … ${d.rerendered.length - shown.length} more re-rendered`)
  }
  const mainShown = main.slice(0, Math.max(0, max - removedShown - lines.length))
  lines.push(...mainShown)
  if (main.length > mainShown.length) lines.push(`… ${main.length - mainShown.length} more added/changed not shown`)
  if (d.returned.length > 0 && d.returned.length <= TREE_DIFF_MAX_BACK_LINES) {
    // A few: listed, their refs may be the ones to use (Google Hotels: the
    // search dialog's combobox came back and was only counted).
    lines.push(...d.returned.map(l => `+ ${clip(l.text, LINE_CHARS)} (back, same ref)`))
  } else if (d.returned.length > 0) {
    lines.push(`+ ${d.returned.length} elements back in the tree exactly as you last saw them, same refs`)
  }
  lines.push(...removedList.slice(0, removedShown).map(l => `− ${clip(l.text, LINE_CHARS)}`))
  const removedHidden = removedList.length - removedShown
  if (removedHidden > 0) {
    lines.push(opts.dialogOpened
      ? `− ${removedHidden} other element${removedHidden === 1 ? ' is' : 's are'} not in the tree while the dialog is open`
      : collapse
        ? `− ${removedHidden} other element${removedHidden === 1 ? '' : 's'} left the tree while a ${popup} appeared`
        : `− ${removedHidden} more no longer in the tree`)
  }
  return `\nTree changes since ${since} (${counts}):\n${lines.join('\n')}`
}

/**
 * What to add to the CLI's `✗ Unknown ref: eN`: what eN was when the agent
 * last saw it, and which refs in the current tree carry exactly that line —
 * so a ref lost to a re-render can be replaced without a snapshot. Only facts:
 * an element that no longer has the ref may have been removed, re-rendered or
 * hidden behind a dialog, and the note does not say which.
 */
export function formatUnknownRef(ref: string, wasText: string, current: TreeRefs): string {
  const id = ref.replace(/^@/, '')
  const was = lineWithoutRef(wasText)
  // The CLI drops its whole ref table when a snapshot fails part-way (a scope
  // selector that matched nothing); a fresh read restores it.
  const again = current.lines.get(id)
  if (again) {
    return `\n${id} is in the current tree again (${clip(lineWithoutRef(again.text), 160)}) after a fresh read — the CLI's ref table had been reset. This action was not performed.`
  }
  const same = [...current.lines.values()].filter(l => lineWithoutRef(l.text) === was)
  const head = `\n${id} was ${clip(was, 160)} when last read; no element in the current tree has that ref.`
  // Which element it was is not known — a calendar's "15" of the next month
  // has the same line — so the note lists, it does not identify.
  if (same.length === 1) return `${head} One element in the current tree has that same role, name and state: @${same[0].ref}.`
  if (same.length > 1) {
    const listed = same.slice(0, 8).map(l => `@${l.ref}`).join(', ')
    return `${head} ${same.length} elements in the current tree have that same role, name and state: ${listed}${same.length > 8 ? ', …' : ''}.`
  }
  // Same role and name in another state (a combobox now expanded=true).
  const roleName = (text: string): string => /^(\S+)(?: ("(?:[^"\\]|\\.)*"))?/.exec(lineWithoutRef(text))?.slice(1).join(' ').trim() ?? ''
  const wantRn = roleName(wasText)
  const similar = /"/.test(wantRn) ? [...current.lines.values()].filter(l => roleName(l.text) === wantRn) : []
  if (similar.length > 0) {
    const listed = similar.slice(0, 5).map(l => `@${l.ref} (${clip(lineWithoutRef(l.text), 100)})`).join(', ')
    return `${head} No element has that role, name and state; with that role and name: ${listed}${similar.length > 5 ? ', …' : ''}.`
  }
  return `${head} No element in the current tree has that role, name and state.`
}

/**
 * The last tree the agent was shown, kept so the next action can be diffed
 * against it. One per browser — the active tab's — and only for the document
 * it was read on: refs are per document. A document is known by its load
 * start (the observer's docStart), so an SPA that changes its URL without a
 * page load keeps its baseline; without one, by URL.
 */
export interface TreeBaseline {
  url: string
  /** performance.timeOrigin of the document read, 0 when unknown. */
  docStart: number
  refs: TreeRefs
  takenAt: number
  source: 'snapshot' | 'action'
  /** Every ref line the agent has been shown on this page, latest text — to tell "back" from "added". */
  seen: Map<string, string>
  /** Read-back values since this tree was read (DiffOptions.acknowledged). */
  acknowledged: Map<string, string | null>
}

let baseline: TreeBaseline | null = null
/** The last baseline of the previous document, kept to explain its refs after a load. */
let previousDocument: TreeBaseline | null = null

/** Cap on remembered lines per page — a long infinite scroll must not grow without bound. */
const SEEN_MAX = 20_000

/** Is `b` a read of the document at `url` / `docStart`? The load start decides when both are known. */
function sameDocumentAs(b: TreeBaseline, url: string, docStart: number): boolean {
  if (docStart > 0 && b.docStart > 0) return b.docStart === docStart
  return b.url === url
}

export function setTreeBaseline(url: string, tree: string, source: TreeBaseline['source'], now = Date.now(), docStart = 0): void {
  if (!url) { baseline = null; return }
  const refs = parseTreeRefs(tree)
  // A copy: a caller may still be diffing against the previous baseline's map.
  const seen = baseline && sameDocumentAs(baseline, url, docStart) ? new Map(baseline.seen) : new Map<string, string>()
  for (const [ref, line] of refs.lines) {
    seen.delete(ref)
    seen.set(ref, line.text)
  }
  while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string)
  if (baseline && !sameDocumentAs(baseline, url, docStart)) previousDocument = baseline
  baseline = { url, refs, takenAt: now, source, docStart, seen, acknowledged: new Map() }
}

/** The baseline for this document (`docStart`, else `url`), or null when there is none. */
export function getTreeBaseline(url: string, docStart = 0): TreeBaseline | null {
  return baseline && sameDocumentAs(baseline, url, docStart) ? baseline : null
}

/** The agent was told `ref`'s value (null: told it changed, value not comparable). */
export function acknowledgeTreeValue(url: string, ref: string, value: string | null, docStart = 0): void {
  const b = getTreeBaseline(url, docStart)
  if (b) b.acknowledged.set(ref.replace(/^@/, ''), value)
}

export function resetTreeBaseline(): void {
  baseline = null
  previousDocument = null
}

/** What `ref` was on the document before the current one, or null. */
export function lineFromPreviousDocument(ref: string): { text: string; url: string } | null {
  const text = previousDocument?.seen.get(ref.replace(/^@/, ''))
  return text && previousDocument ? { text, url: previousDocument.url } : null
}
