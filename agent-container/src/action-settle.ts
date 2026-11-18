/**
 * Action settle — the act-side consumer of the page observer.
 *
 * Run a mutating action between two observations and say what it did:
 * dialogs opened or closed, live-region announcements, the change in
 * interactive elements, control state (a box ticked, a toggle pressed, a
 * panel expanded), typed field values, focus — or, honestly, that nothing
 * in that scope changed (transcript-mining theme 3: "URL unchanged" was the
 * whole result on a single-page app, whether a dialog opened, a toast fired
 * or the click was swallowed). No snapshot is involved, so the CLI's ref
 * registry never rotates.
 *
 * After the verb's settle, if nothing at all changed and a late effect is
 * plausible for that verb (policy.recheck), one later read guards against
 * effects that land just after the settle (a Shopify cart drawer opened
 * after 300ms). Every clause is a before-versus-after diff.
 *
 * The line states observations only. When nothing was seen it says so and
 * names what was looked at; it never concludes that the click was swallowed,
 * the element disabled or the page finished — the agent can establish those
 * with a snapshot or a screenshot, and a wrong verdict here costs more than
 * the step it would have saved.
 *
 * When the observer sees a structural change (effectWantsTree), the server
 * reads the interactive tree once and the result lists the changed elements
 * with their refs under the Effect line (tree-diff.ts) — agent-browser 0.38+
 * keeps refs across snapshots, so that read no longer renumbers anything.
 */
import { observerScript, parseObservation, type PageObservation, type TopLayerEntry } from './page-observer'
import { FILL_SETTLE_MS, PRESS_ENTER_SETTLE_MS, PRESS_SETTLE_MS } from './browser-digest'
import type { NetworkActivity } from './network-activity'
import { formatTreeDiff, treeDiffIsEmpty, type TreeDiff, type TreeDiffFormatOptions } from './tree-diff'

export type ActionVerb = 'click' | 'press' | 'select' | 'hover' | 'fill' | 'type'

export interface ActionPolicy {
  verb: ActionVerb
  /** First read this long after the action. */
  settleMs: number
  /** If the first read finds nothing, read again this long after the action. */
  recheckMs: number
  /**
   * Whether a focus move or a typed value decides "something changed" for the
   * recheck (press) — a click moves focus to its own target, which must not
   * hide a late effect. The focus is still reported either way.
   */
  countFocus: boolean
  /**
   * Given silence at the settle, is a late effect plausible enough to pay for
   * the recheck? The recheck exists for a drawer that opens 900ms after a
   * click; it is wasted after a click that merely landed focus in a text
   * field, a Tab, an Escape, or a hover that opened nothing.
   */
  recheck: (effect: ActionEffect) => boolean
}

const RECHECK_MS = 1200
/** The second look when the action issued no request: a late render, not a result on its way. */
const QUIET_RECHECK_MS = 600
/** While a spinner the action raised is still up, the page is read again every BUSY_POLL_MS, until BUSY_WAIT_MS. */
const BUSY_POLL_MS = 600
const BUSY_WAIT_MS = 3000

/** Focus roles that take typing: a click landing here is complete in itself. */
const TEXT_FIELD_FOCUS = /^(textbox|searchbox|combobox|textarea|input)\b/
const focusedTextField = (e: ActionEffect): boolean => e.focusChanged && TEXT_FIELD_FOCUS.test(e.focus)
/** Keys that submit or activate — the ones whose effect can arrive late. */
const ACTIVATING_KEYS = new Set(['enter', 'return', 'space', ' '])

export const ACTION_POLICIES: Record<ActionVerb, ActionPolicy> = {
  // A click into a field that announced something (MUI's async autocomplete:
  // "Loading…", options a second later) is not complete in itself.
  click: { verb: 'click', settleMs: 300, recheckMs: RECHECK_MS, countFocus: false, recheck: e => !focusedTextField(e) || e.announced.length > 0 },
  press: { verb: 'press', settleMs: PRESS_SETTLE_MS, recheckMs: RECHECK_MS, countFocus: true, recheck: () => false },
  select: { verb: 'select', settleMs: 300, recheckMs: RECHECK_MS, countFocus: false, recheck: () => true },
  // A menu opens within the settle or not at all.
  hover: { verb: 'hover', settleMs: 300, recheckMs: RECHECK_MS, countFocus: false, recheck: () => false },
  // The field's own value is read back separately; the settle is for what the
  // input set off — a suggestion list, a validation message, revealed fields.
  // A field that announced "Loading…" is fetching suggestions: worth the late read.
  fill: { verb: 'fill', settleMs: FILL_SETTLE_MS, recheckMs: RECHECK_MS, countFocus: false, recheck: e => e.announced.length > 0 },
  type: { verb: 'type', settleMs: 300, recheckMs: RECHECK_MS, countFocus: false, recheck: e => e.announced.length > 0 },
}

/**
 * The press policy for one key: Enter and Space submit or activate (also as
 * the last part of a combo such as Control+Enter), so they get a click-sized
 * settle and the recheck; every other key (Tab, Escape, arrows, modifier
 * combos) acts at once or not at all.
 */
export function pressPolicy(key: string): ActionPolicy {
  const last = key.trim().toLowerCase().split('+').pop() ?? ''
  const activating = ACTIVATING_KEYS.has(last)
  // Escape closes things, and a closing dialog animates out (MUI: ~200 ms)
  // — at 50 ms it was still there and "dialog closed" was missed.
  const settleMs = activating || last === 'escape' || last === 'esc' ? PRESS_ENTER_SETTLE_MS : PRESS_SETTLE_MS
  return { ...ACTION_POLICIES.press, settleMs, recheck: () => activating }
}

export interface ActionEffect {
  opened: TopLayerEntry[]
  closed: TopLayerEntry[]
  interactiveDelta: number
  /** A visible control's state changed (checked, pressed, expanded, selected, disabled, chosen option). */
  stateChanged: boolean
  announced: string[]
  /** The content region's text differs in length and in content — a same-length change (a clock, a counter) is not reported. */
  textChanged: boolean
  /** after.contentChars − before.contentChars; a size for "page text changed". */
  textDelta: number
  focus: string
  /** The visible controls' labels changed with their count the same — a view swapped in place. */
  labelsChanged: boolean
  /** A challenge wall the observer recognises is up now and was not before the action (vendor name), or ''. */
  blockerAppeared: string
  /** Focus is on a different element — by identity, not only by display name (two unnamed inputs are two elements). */
  focusChanged: boolean
  /** The focused field's full value differs, with focus on the same element (typing, clear). Detected on a hash of the whole value, not the preview. */
  focusValueChanged: boolean
  /** Preview of the value (capped by the observer) and the full value's length. */
  focusValue: string
  focusValueChars: number
  /**
   * More progress indicators (spinners, aria-busy, progressbars) are visible
   * than before the action: what it started is still loading.
   */
  busyRose?: boolean
  /**
   * The content text changed with its length the same (a total from $37,695
   * to $38,170). Not reported as text — a clock does that too — but worth a
   * tree read after a click, press or select.
   */
  textReplaced?: boolean
  /** Visible cross-origin frames: their contents are not read. */
  unreadFrames?: number
}

const topKey = (e: TopLayerEntry): string => `${e.kind}|${e.name}`

/** What changed between the two reads. */
export function diffObservations(before: PageObservation, after: PageObservation): ActionEffect {
  const beforeTop = new Set(before.top.map(topKey))
  const afterTop = new Set(after.top.map(topKey))
  const beforeLive = new Set(before.liveRegions)
  return {
    opened: after.top.filter(e => !beforeTop.has(topKey(e))),
    closed: before.top.filter(e => !afterTop.has(topKey(e))),
    interactiveDelta: after.interactive - before.interactive,
    stateChanged: after.stateHash !== before.stateHash,
    labelsChanged: after.interactive === before.interactive && after.labelHash !== before.labelHash,
    blockerAppeared: after.blocker && !before.blocker ? after.blocker : '',
    announced: after.liveRegions.filter(s => !beforeLive.has(s)),
    textChanged: after.contentHash !== before.contentHash && after.contentChars !== before.contentChars,
    textDelta: after.contentChars - before.contentChars,
    focus: after.focus,
    focusChanged: after.focus !== before.focus || after.focusId !== before.focusId,
    focusValueChanged: after.focus === before.focus && after.focusId === before.focusId && after.focusValueHash !== before.focusValueHash,
    focusValue: after.focusValue,
    focusValueChars: after.focusValueChars,
    busyRose: after.busy > before.busy,
    textReplaced: after.contentHash !== before.contentHash && after.contentChars === before.contentChars,
    unreadFrames: after.iframes.filter(f => !f.sameOrigin).length,
  }
}

/** Two reads of one document: its load started at the same instant. */
export function sameDocument(a: PageObservation | null, b: PageObservation | null): boolean {
  return Boolean(a && b && a.docStart > 0 && a.docStart === b.docStart)
}

/**
 * A different document, whatever the URL: both load starts known and not
 * equal. A failed login that posts and lands back on /login is a page load
 * at the same URL (the-internet.herokuapp.com).
 */
export function newDocument(a: PageObservation | null, b: PageObservation | null): boolean {
  return Boolean(a && b && a.docStart > 0 && b.docStart > 0 && a.docStart !== b.docStart)
}

/**
 * The page's content moved: a dialog, the control census, text or a
 * challenge. A control's own state or label, focus or an announcement alone is not
 * this — a filter checkbox ticks at once and its results arrive later
 * (bench, toolshop: each grid landed in the NEXT action's diff).
 */
export function contentChanged(e: ActionEffect): boolean {
  // A text change no larger than what was announced (plus a separator each)
  // is the announcement itself ("Loading suggestions…" in a status region),
  // not the result.
  const announcedChars = e.announced.reduce((n, a) => n + a.length + 2, 0)
  const textMoved = e.textChanged && !(announcedChars > 0 && Math.abs(e.textDelta) <= announcedChars)
  // Labels alone are not it either: a button whose text turns into a spinner
  // (DuckDuckGo's "More results") flips its label before the results come;
  // a view swapped in place changes the page's text too.
  return e.opened.length > 0 || e.closed.length > 0 || e.interactiveDelta !== 0 || textMoved || e.blockerAppeared !== ''
}

/** True when the diff found anything the result will report. */
export function effectHasChange(e: ActionEffect, opts: { countFocus?: boolean } = {}): boolean {
  const countFocus = opts.countFocus ?? true
  return (
    e.opened.length > 0 || e.closed.length > 0 || e.announced.length > 0 ||
    e.interactiveDelta !== 0 || e.stateChanged || e.labelsChanged || e.textChanged || e.blockerAppeared !== '' || (countFocus && (e.focusChanged || e.focusValueChanged))
  )
}

export interface SettleResult {
  before: PageObservation | null
  after: PageObservation | null
  effect: ActionEffect | null
  /** How long after the action the reported state was read. */
  waitedMs: number
}

export interface ObserveActionOptions<R> {
  /**
   * Run the action; a failed action (non-zero exit) ends the settle at once.
   * Gets the before-read, so how to act can depend on the page (a challenge
   * wall switches the click to a human-like mouse path).
   */
  exec: (before: PageObservation | null) => Promise<R>
  isFailure: (r: R) => boolean
  /** Run an observer script in the page and return its stdout, or null if it could not run. */
  evalScript: (script: string) => Promise<string | null>
  policy: ActionPolicy
  /**
   * The page's own requests (network-activity.ts): `start` clears the log as
   * the action begins and says whether it could; `since` reads what was
   * issued after. Without it, or when a read fails, the recheck waits the
   * full time as before.
   */
  network?: { start: () => Promise<boolean>; since: () => Promise<NetworkActivity | null> }
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Before-read, action, settle, then one read — and one more at the recheck
 * when the first found nothing and the verb allows for a late effect. No
 * effect is claimed across a navigation — the two documents are not
 * comparable — the caller sees that in `after.url`.
 */
export async function observeAction<R>(opts: ObserveActionOptions<R>): Promise<{ result: R } & SettleResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = opts.now ?? (() => Date.now())
  const { policy } = opts
  const read = async (): Promise<PageObservation | null> => {
    const out = await opts.evalScript(observerScript())
    return out === null ? null : parseObservation(out)
  }

  const before = await read()
  const tracking = opts.network ? await opts.network.start() : false
  const since = async (): Promise<NetworkActivity | null> => (tracking && opts.network ? opts.network.since() : null)
  const result = await opts.exec(before)
  if (opts.isFailure(result)) return { result, before, after: null, effect: null, waitedMs: 0 }

  const actedAt = now()
  const elapsed = (): number => now() - actedAt
  // Comparable: the same URL, or the same document under a new URL (an SPA's
  // pushState) — a reload or a real navigation is a different page.
  const diff = (after: PageObservation | null): ActionEffect | null =>
    before && after && ((after.url === before.url && !newDocument(before, after)) || sameDocument(before, after)) ? diffObservations(before, after) : null

  await sleep(policy.settleMs)
  let after = await read()
  let effect = diff(after)

  // An announcement alone ("Searching…") is a promise, not the result: it
  // does not stand in for the late read (bench, Placer: the results arrived
  // after "Searching…" and the result never showed them).
  // Recheck when the content has not moved yet. For a press (countFocus) a
  // focus move or typed value is itself the result. An announcement with no
  // control added or removed and no dialog is a promise ("Loading…"), even
  // when a label flipped with it (the field's Open button now reads Close).
  const promised = (e: ActionEffect): boolean =>
    e.announced.length > 0 && e.interactiveDelta === 0 && e.opened.length === 0 && e.closed.length === 0 && e.blockerAppeared === ''
  // A spinner that appeared with the action is a promise too, whatever else
  // moved (DuckDuckGo's "More results": the button turned into a spinner,
  // the results came a second later).
  const onlyClosed = (e: ActionEffect): boolean =>
    e.interactiveDelta < 0 && e.opened.length === 0 && (!e.textChanged || e.textDelta < 0) && !e.labelsChanged && e.blockerAppeared === '' && e.announced.length === 0
  const settledYet = (e: ActionEffect): boolean =>
    !promised(e) && !e.busyRose && !((policy.verb === 'click' || policy.verb === 'press') && onlyClosed(e)) &&
    (contentChanged(e) || (policy.countFocus && (e.focusChanged || e.focusValueChanged)))
  const wantsMore = (e: ActionEffect): boolean => policy.recheck(e) || (Boolean(e.busyRose) && policy.verb !== 'hover')
  if (effect && !settledYet(effect) && wantsMore(effect) && elapsed() < policy.recheckMs) {
    // Silence at the settle: a late effect is the other explanation. How
    // late depends on what the action asked the server for: requests it
    // issued mean results on their way; none — and no "Loading…" or spinner
    // from the page either — one short second look.
    let net = await since()
    const quiet = net !== null && net.issued === 0 && !promised(effect) && !effect.busyRose
    await sleep(Math.max(0, (quiet ? QUIET_RECHECK_MS : policy.recheckMs) - elapsed()))
    const announced = new Set(effect.announced)
    for (;;) {
      const again = await read()
      if (!again) break
      const next = diff(again)
      after = again
      effect = next
      if (!next) break
      next.announced.forEach(a => announced.add(a))
      // Still loading — a spinner it raised, or a request it issued with no
      // response yet: look again, up to BUSY_WAIT_MS after the action.
      if (!next.busyRose) net = net && net.pending > 0 ? await since() : net
      if (!(next.busyRose || (net !== null && net.pending > 0)) || elapsed() + BUSY_POLL_MS > BUSY_WAIT_MS) break
      await sleep(BUSY_POLL_MS)
    }
    // What was announced at the settle stays reported if it is gone by now.
    if (effect) effect = { ...effect, announced: [...announced] }
  }
  return { result, before, after, effect, waitedMs: Math.round(elapsed()) }
}

/**
 * Is the change one the tree can show? Dialogs, the interactive census and
 * control state are structural; a text change is, for the verbs that load
 * results in place (a filter click, Enter in a search box, a select). A
 * live-region announcement or a focus move alone is not worth a tree read.
 */
export function effectWantsTree(e: ActionEffect, verb: ActionVerb): boolean {
  if (e.opened.length > 0 || e.closed.length > 0 || e.interactiveDelta !== 0 || e.stateChanged) return true
  return (e.textChanged || e.labelsChanged || Boolean(e.textReplaced)) && (verb === 'click' || verb === 'press' || verb === 'select')
}

export interface EffectTreeDiff extends Pick<TreeDiffFormatOptions, 'baselineSource'> {
  diff: TreeDiff
  baselineAgeMs: number
}

export interface EffectFormatOptions {
  /** How long after the action the reported state was read. */
  settleMs: number
  verb: ActionVerb
  /** The tree diff read after the action, when the observer saw a structural change and a baseline existed. */
  treeDiff?: EffectTreeDiff | null
  /**
   * The result already reads the target field back (fill, type into a ref):
   * leave out the field-value clause, and say nothing when nothing else
   * changed — "none observed" after every fill is noise.
   */
  valueReadBack?: boolean
}

/** What the observer looks at — named when nothing was seen, so the agent knows the scope of that silence. */
const OBSERVED_SCOPE = 'dialogs, live regions, page text, control state, focus'

/**
 * One line describing the effect. Leads with what a person would notice
 * (dialog opened, announcement), then the census delta, control state, typed
 * values and focus. When nothing was seen it says so and names what was
 * looked at — no verdict on why.
 */
export function formatActionEffect(effect: ActionEffect | null, opts: EffectFormatOptions): string {
  if (!effect) return ''
  const tree = opts.treeDiff && !treeDiffIsEmpty(opts.treeDiff.diff)
    ? formatTreeDiff(opts.treeDiff.diff, {
      baselineAgeMs: opts.treeDiff.baselineAgeMs,
      baselineSource: opts.treeDiff.baselineSource,
      dialogOpened: effect.opened.length > 0,
    })
    : ''
  // The tree lines name the elements; the census and the state hash would
  // only repeat them as a count. With the target read back, an empty diff
  // (the target's own subtree is left out of it) means the target was all
  // that changed — the counts would be about it alone.
  const counted = !tree && !(opts.valueReadBack && opts.treeDiff)
  // Except what the page did with a select's value without adding or
  // removing anything: a re-sort keeps every element and line, so the diff
  // is empty while the controls' labels moved (live: toolshop's sort).
  const resorted = !tree && opts.verb === 'select' && Boolean(opts.treeDiff) && effect.interactiveDelta === 0 && effect.labelsChanged
  const parts: string[] = []
  // First: the page is now a challenge wall (the same recognition as the
  // status line's ⚠ — vendor DOM or wording, never a guess).
  if (effect.blockerAppeared) parts.push(`${effect.blockerAppeared} challenge page now showing`)
  for (const e of effect.opened) parts.push(`${e.kind}${e.name ? ` ${JSON.stringify(e.name)}` : ''} opened`)
  for (const e of effect.closed) parts.push(`${e.kind}${e.name ? ` ${JSON.stringify(e.name)}` : ''} closed`)
  if (effect.announced.length > 0) parts.push(`announced: ${effect.announced.map(s => JSON.stringify(s)).join(' | ')}`)
  if (effect.interactiveDelta !== 0 && counted) {
    parts.push(`${effect.interactiveDelta > 0 ? '+' : ''}${effect.interactiveDelta} interactive elements`)
  } else if (parts.length === 0 && effect.textChanged && counted) {
    const d = effect.textDelta
    parts.push(`page text changed (${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')} chars)`)
  }
  // State is read as one hash over the visible controls: with controls added
  // or removed, or the read-back target's own state in it, it says nothing more.
  const stateNote = effect.stateChanged && counted && effect.interactiveDelta === 0 && !opts.valueReadBack
  if (stateNote) parts.push('control state changed (checked/pressed/expanded/selected)')
  if (effect.labelsChanged && counted && !stateNote) parts.push('labels of visible controls changed')
  if (resorted) parts.push('labels of visible controls changed; the tree has the same elements as before')
  // Still there at the last read: the page is loading something.
  if (effect.busyRose) parts.push('a progress indicator (spinner, aria-busy) that appeared with this action is still showing')
  if (effect.focusValueChanged && !opts.valueReadBack) {
    const preview = effect.focusValue.length < effect.focusValueChars
    parts.push(`field value now ${JSON.stringify(effect.focusValue)}${preview ? ` (${effect.focusValueChars} chars, first ${effect.focusValue.length} shown)` : ''}`)
  }
  // Focus is a fact worth a few chars: for a press it is where the next key
  // goes; for a click it shows which element took the click.
  const focusNote = effect.focus && (opts.verb === 'press' || (opts.verb === 'click' && effect.focusChanged)) ? `focus: ${effect.focus}` : ''
  if (parts.length === 0) {
    // "Effect: tree changes since …" — the tree is the whole observation.
    if (tree) return focusNote ? `\nEffect: ${focusNote}${tree}` : `\nEffect: t${tree.slice(2)}`
    if (opts.valueReadBack) return ''
    if (focusNote && effect.focusChanged) return `\nEffect: ${focusNote}`
    const frames = effect.unreadFrames ? `; not read: ${effect.unreadFrames} cross-origin frame${effect.unreadFrames === 1 ? '' : 's'}` : ''
    return `\nEffect: none observed within ${opts.settleMs}ms (${OBSERVED_SCOPE}${frames})${focusNote ? ` — ${focusNote}` : ''}`
  }
  if (focusNote) parts.push(focusNote)
  return `\nEffect: ${parts.join(' · ')}${tree}`
}
