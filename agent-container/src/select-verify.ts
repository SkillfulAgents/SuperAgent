/**
 * Commit verification for browser_select (browser-tools audit P0 #4).
 *
 * agent-browser's `select` returns "✓ Done" unconditionally: on custom
 * dropdown divs it silently no-ops, and on React-controlled native selects
 * the value can revert asynchronously after the success ack (probe P2:
 * 'Selected "US"' followed by value="" with 245 options). The fix is to read
 * the element's value back after a settle delay and judge whether anything
 * actually committed.
 *
 * The read-back is `get value`, i.e. the option's VALUE, while the agent may
 * have asked by visible LABEL. When the requested label's option was already
 * selected, value-before equals value-after and neither equals the request —
 * which used to be reported as "did not commit" ("requested California,
 * element value is still CA"; mining theme 24). In that one case the route
 * reads the target's own option list with `get html @ref` — a second read
 * the CLI resolves against the same ref as the select and the value read —
 * and checks whether the option holding the read-back value carries the
 * requested label. No page script is involved: a page-wide search can be
 * satisfied by a sibling dropdown, focus can be redirected by an onfocus
 * handler, and elementFromPoint returns whichever control covers the
 * target — all three verified the wrong element in review.
 */

export const SELECT_COMMIT_SETTLE_MS = 300

export const CUSTOM_DROPDOWN_RECIPE =
  'If this is a custom dropdown (not a native <select>), select-by-value cannot work. ' +
  'Recipe: browser_click the trigger, re-snapshot, type into the popup\'s filter input to narrow the list, ' +
  'click the option\'s FRESH ref, then re-snapshot and verify the committed state. ' +
  'Note: refs renumber after each committed selection — re-snapshot between selections.'

export type SelectJudgement =
  | { ok: true; committed: string }
  | { ok: false; reason: string }

export interface SelectOption { value: string; label: string }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/**
 * Tokenize a start tag's attributes from `src[i]` (just after the tag
 * name) to its closing `>`. Walks the text character by character so a
 * quoted value can contain `>`, `=`, or text that looks like another
 * attribute (review: `title="Search label='California'"` was read as a
 * label attribute by a regex). The first occurrence of a name wins, as in
 * the DOM. Returns the attributes and the index just past `>`.
 */
function parseAttributes(src: string, i: number): { attrs: Record<string, string>; end: number } {
  const attrs: Record<string, string> = {}
  const n = src.length
  while (i < n) {
    while (i < n && /[\s/]/.test(src[i])) i++
    if (i >= n) break
    if (src[i] === '>') return { attrs, end: i + 1 }
    let j = i
    while (j < n && !/[\s=>/]/.test(src[j])) j++
    const name = src.slice(i, j).toLowerCase()
    i = j
    while (i < n && /\s/.test(src[i])) i++
    let value = ''
    if (src[i] === '=') {
      i++
      while (i < n && /\s/.test(src[i])) i++
      const q = src[i]
      if (q === '"' || q === "'") {
        const close = src.indexOf(q, i + 1)
        value = close === -1 ? src.slice(i + 1) : src.slice(i + 1, close)
        i = close === -1 ? n : close + 1
      } else {
        j = i
        while (j < n && !/[\s>]/.test(src[j])) j++
        value = src.slice(i, j)
        i = j
      }
    }
    if (name && !(name in attrs)) attrs[name] = decodeEntities(value)
  }
  return { attrs, end: n }
}

/** Index of the next `<option`, `<optgroup`, `</optgroup`, `</select` or `</option` tag at or after `from`. */
function nextOptionBoundary(src: string, from: number): number {
  const re = /<\/?(option|optgroup|select)\b/gi
  re.lastIndex = from
  const m = re.exec(src)
  return m ? m.index : src.length
}

/**
 * The options of a <select>, from its innerHTML as `get html @ref` returns
 * it. `label` follows the DOM's option.label: the label attribute when
 * present, else the text; `value` follows option.value: the value attribute
 * when present, else the text. Tags are tokenized, not regex-matched, and
 * an option's text ends at the next option/optgroup/select tag, so the
 * `</option>` HTML lets authors omit is not required.
 */
export function parseSelectOptions(html: string): SelectOption[] {
  const out: SelectOption[] = []
  // Option-shaped text that is not an option: comments, and the inert
  // contents of <template>/<script>/<style> (review: a commented-out
  // <option> verified a selection that was never available).
  const live = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(template|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  const open = /<option\b/gi
  let m: RegExpExecArray | null
  while ((m = open.exec(live)) !== null) {
    const { attrs, end } = parseAttributes(live, m.index + '<option'.length)
    const stop = nextOptionBoundary(live, end)
    const text = decodeEntities(live.slice(end, stop).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
    out.push({ value: 'value' in attrs ? attrs.value : text, label: ('label' in attrs ? attrs.label : text).trim() })
    open.lastIndex = Math.max(end, stop)
  }
  return out
}

/**
 * Does the target's option holding `value` carry the requested label? Read
 * from the target's own option list, so a sibling dropdown, a redirected
 * focus or a covering control cannot answer for it.
 */
export function targetOptionMatches(options: SelectOption[], requested: string, value: string): boolean {
  const want = requested.trim()
  // The read-back value names an option only when every option carrying
  // that value has the same label: with duplicate values (California and
  // New York both "0") the value does not say which is selected, so the
  // verification is unknown, not a match.
  const holders = options.filter(o => o.value === value)
  return holders.length > 0 && holders.every(o => o.label === want)
}

/**
 * Judge whether a select committed, from the element's value read before and
 * after the select call (null = the read failed).
 *
 * Selecting by visible label is supported by the CLI, so a successful commit
 * may land on a value different from the requested string — any post-select
 * change counts as a commit, and the committed value is reported back. When
 * nothing changed, `labelMatches` (the target's option holding the current
 * value carries the requested label) also counts as committed: the request
 * was already satisfied.
 */
export function judgeSelectCommit(
  requested: string,
  before: string | null,
  after: string | null,
  labelMatches = false
): SelectJudgement {
  if (after === null) {
    // A failed `get value` has many causes (navigation, detached ref, a
    // connection drop, an element with no value property). None is known
    // here, so none is named.
    return {
      ok: false,
      reason:
        `select reported success but the element's value could not be read back afterwards, so the selection is unverified. ${CUSTOM_DROPDOWN_RECIPE}`,
    }
  }
  if (after === requested) {
    return { ok: true, committed: after }
  }
  if (before !== null && after !== before) {
    // Changed to something other than the requested string: selected by
    // visible label; the committed option VALUE is reported.
    return { ok: true, committed: after }
  }
  if (labelMatches) {
    return { ok: true, committed: after }
  }
  return {
    ok: false,
    reason:
      `select reported success but the element's value did not change (still "${after}"; requested "${requested}"). ${CUSTOM_DROPDOWN_RECIPE}`,
  }
}
