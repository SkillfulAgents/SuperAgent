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
 * reads the target's own selected option. The CLI resolves refs, not page
 * scripts, so the target is identified geometrically: `get box @ref` gives
 * its rectangle and the in-page script takes the <select> at that point
 * whose rectangle matches — never document.activeElement (a page's onfocus
 * handler can move focus to another dropdown) and never a page-wide search
 * (a sibling dropdown can hold the requested label).
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

export interface ElementBox { x: number; y: number; width: number; height: number }

/** Parse `get box @ref --json` ({"success":true,"data":{x,y,width,height}}) or the bare data object. */
export function parseElementBox(stdout: string): ElementBox | null {
  try {
    let parsed: unknown = JSON.parse(stdout.trim())
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    const o = parsed as Record<string, unknown> | null
    const d = (o && typeof o.data === 'object' && o.data !== null ? o.data : o) as Record<string, unknown> | null
    if (!d) return null
    const n = (k: string): number | null => (typeof d[k] === 'number' && Number.isFinite(d[k] as number) ? (d[k] as number) : null)
    const x = n('x'), y = n('y'), width = n('width'), height = n('height')
    if (x === null || y === null || width === null || height === null) return null
    return { x, y, width, height }
  } catch {
    return null
  }
}

/**
 * In-page script: the <select> whose rectangle is `box`, read at the box's
 * centre. The CLI's box may be viewport- or document-relative, so both
 * interpretations are tried and a hit must also match the box's size and
 * position (±2px). Returns {value,label} — `label` is option.label, which
 * honours a `label` attribute and falls back to the text — or null when no
 * <select> with that rectangle is at that point.
 */
export function selectTargetStateScript(box: ElementBox): string {
  const b = JSON.stringify({ x: box.x, y: box.y, w: box.width, h: box.height })
  return (
    'JSON.stringify((function(){var b=' + b + ';var cands=[[b.x+b.w/2,b.y+b.h/2,0,0],[b.x+b.w/2-window.scrollX,b.y+b.h/2-window.scrollY,window.scrollX,window.scrollY]];' +
    'for(var i=0;i<cands.length;i++){var c=cands[i];var e=document.elementFromPoint(c[0],c[1]);' +
    'if(!e||e.tagName!=="SELECT")continue;var r=e.getBoundingClientRect();' +
    'if(Math.abs(r.width-b.w)>2||Math.abs(r.height-b.h)>2||Math.abs(r.left+c[2]-b.x)>2||Math.abs(r.top+c[3]-b.y)>2)continue;' +
    'var o=e.selectedOptions&&e.selectedOptions[0];return{value:String(e.value),label:o?String(o.label||o.text||"").trim():""}}return null})())'
  )
}

export interface SelectTargetState { value: string; label: string }

/** Parse the (possibly double-JSON-encoded) output of selectTargetStateScript. */
export function parseSelectTargetState(stdout: string): SelectTargetState | null {
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

/** Does the target hold `value` under the requested label? */
export function targetMatches(state: SelectTargetState | null, requested: string, value: string): boolean {
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
