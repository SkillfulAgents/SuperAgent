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

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs)
  if (!m) return null
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '')
}

/**
 * The options of a <select>, from its innerHTML as `get html @ref` returns
 * it. `label` follows the DOM's option.label: the label attribute when
 * present, else the text; `value` follows option.value: the value attribute
 * when present, else the text.
 */
export function parseSelectOptions(html: string): SelectOption[] {
  const out: SelectOption[] = []
  // Option-shaped text that is not an option: comments, and the inert
  // contents of <template>/<script>/<style> (review: a commented-out
  // <option> verified a selection that was never available).
  const live = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(template|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(live)) !== null) {
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
    const value = attr(m[1], 'value')
    const label = attr(m[1], 'label')
    out.push({ value: value ?? text, label: (label ?? text).trim() })
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
