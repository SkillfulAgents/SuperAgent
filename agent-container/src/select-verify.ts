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
 * focuses the target (`focus @ref`) and reads the focused element's own
 * value and selected label — the target itself, not any <select> on the
 * page — and passes the result in as `labelMatches`.
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

/**
 * In-page script, run after `focus @ref`: the focused element's value and
 * selected option label, or null when the focused element is not a select.
 * Only the element the CLI focused is inspected — never a sibling dropdown.
 */
export const FOCUSED_SELECT_STATE_SCRIPT =
  'JSON.stringify((function(){var a=document.activeElement;if(!a||a.tagName!=="SELECT")return null;' +
  'var o=a.selectedOptions&&a.selectedOptions[0];return{value:String(a.value),label:o?String(o.text||"").trim():""}})())'

export interface FocusedSelectState { value: string; label: string }

/** Parse the (possibly double-JSON-encoded) output of FOCUSED_SELECT_STATE_SCRIPT. */
export function parseFocusedSelectState(stdout: string): FocusedSelectState | null {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    if (!parsed || typeof parsed !== 'object') return null
    const o = parsed as Record<string, unknown>
    if (typeof o.value !== 'string' || typeof o.label !== 'string') return null
    return { value: o.value, label: o.label }
  } catch {
    return null
  }
}

/** Does the focused target hold `value` under the requested label? */
export function focusedTargetMatches(state: FocusedSelectState | null, requested: string, value: string): boolean {
  return state !== null && state.value === value && state.label === requested.trim()
}

/**
 * Judge whether a select committed, from the element's value read before and
 * after the select call (null = the read failed).
 *
 * Selecting by visible label is supported by the CLI, so a successful commit
 * may land on a value different from the requested string — any post-select
 * change counts as a commit, and the committed value is reported back. When
 * nothing changed, `labelMatches` (the target's selected option carries the
 * requested label) also counts as committed: the request was already
 * satisfied.
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
