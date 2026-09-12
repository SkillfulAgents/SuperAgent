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
 * element value is still CA"; mining theme 24). The route now checks the
 * page for a <select> holding that value whose option with that value
 * carries the requested label, and passes the result in as `labelMatches`.
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
 * In-page script: is there a <select> whose current value is `value` and
 * whose option with that value has the visible label `requested`? Strings
 * are JSON-embedded, so agent input cannot break out of the script.
 */
export function selectLabelMatchScript(requested: string, value: string): string {
  const r = JSON.stringify(requested.trim())
  const v = JSON.stringify(value)
  return (
    'JSON.stringify([].some.call(document.querySelectorAll("select"),function(s){' +
    `if(s.value!==${v})return false;` +
    `return [].some.call(s.options,function(o){return o.value===${v}&&String(o.text||"").trim()===${r}})}))`
  )
}

/** Parse the (possibly double-JSON-encoded) output of selectLabelMatchScript. */
export function parseLabelMatch(stdout: string): boolean {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    return parsed === true
  } catch {
    return false
  }
}

/**
 * Judge whether a select committed, from the element's value read before and
 * after the select call (null = the read failed, e.g. no value property).
 *
 * Selecting by visible label is supported by the CLI, so a successful commit
 * may land on a value different from the requested string — any post-select
 * change counts as a commit, and the committed value is reported back. When
 * nothing changed, `labelMatches` (the requested label names the option that
 * holds the current value) also counts as committed: the request was already
 * satisfied.
 */
export function judgeSelectCommit(
  requested: string,
  before: string | null,
  after: string | null,
  labelMatches = false
): SelectJudgement {
  if (after === null) {
    return {
      ok: false,
      reason:
        `select reported success but the target has no value property to read back, so it is not a native <select>. ${CUSTOM_DROPDOWN_RECIPE}`,
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
