/**
 * Commit verification for browser_select (browser-tools audit P0 #4).
 *
 * agent-browser's `select` returns "✓ Done" unconditionally: on custom
 * dropdown divs it silently no-ops, and on React-controlled native selects
 * the value can revert asynchronously after the success ack (probe P2:
 * 'Selected "US"' followed by value="" with 245 options). The fix is to read
 * the element's value back after a settle delay and judge whether anything
 * actually committed.
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
 * Judge whether a select committed, from the element's value read before and
 * after the select call (null = the read failed, e.g. no value property).
 *
 * Selecting by visible label is supported by the CLI, so a successful commit
 * may land on a value different from the requested string — any post-select
 * change counts as a commit, and the committed value is reported back.
 */
export function judgeSelectCommit(
  requested: string,
  before: string | null,
  after: string | null
): SelectJudgement {
  if (after === null) {
    return {
      ok: false,
      reason:
        `select reported success but the target has no readable value — it is probably not a native <select>. ${CUSTOM_DROPDOWN_RECIPE}`,
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
  return {
    ok: false,
    reason:
      `select reported success but the value did not commit (requested "${requested}", element value is still "${after}"). ` +
      `The site either reverted the change (React-controlled select) or the target is not a native <select>. ${CUSTOM_DROPDOWN_RECIPE}`,
  }
}
