/**
 * Action settle — the second primitive built on the page observer.
 *
 * Run a mutating action between two observations and say what it did:
 * dialogs opened or closed, live-region announcements, failed requests, the
 * change in interactive elements, typed field values, focus — or, honestly,
 * nothing (transcript-mining theme 3: "URL unchanged" was the whole result on
 * a single-page app, whether a dialog opened, a toast fired or the click was
 * swallowed). No snapshot is involved, so the CLI's ref registry never
 * rotates.
 *
 * Settling is the affordance a person gets from the browser's spinner. After
 * the verb's settle, if the page is still working (requests in flight, a
 * spinner or top bar that started after the action) the poll continues until
 * it stops or a cap; if nothing at all changed and a late effect is plausible
 * for that verb (policy.recheck), one later read guards against effects that
 * land just after the settle (a Shopify cart drawer opened after 300ms).
 * Every clause is a before-versus-after diff.
 *
 * The line states observations only. When nothing was seen it says so and
 * names what was looked at; it never concludes that the click was swallowed,
 * the element disabled or the page finished — the agent can establish those
 * with a snapshot or a screenshot, and a wrong verdict here costs more than
 * the step it would have saved.
 *
 * Attaching to a new action is one policy row plus one `observeAction` call.
 */
import {
  busyKey, describeBusy, observerScript, parseObservation, transientBusy,
  type BusyIndicator, type FailedRequest, type PageObservation, type TopLayerEntry,
} from './page-observer'
import { PRESS_ENTER_SETTLE_MS, PRESS_SETTLE_MS } from './browser-digest'

export type ActionVerb = 'click' | 'press' | 'select' | 'hover' | 'scroll'

export interface ActionPolicy {
  verb: ActionVerb
  /** First read this long after the action. */
  settleMs: number
  /** If the first read finds nothing, read again this long after the action. */
  recheckMs: number
  /** While the page is busy, keep polling at this interval… */
  pollMs: number
  /** …until this long after the action. */
  capMs: number
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

const base = { recheckMs: 1200, pollMs: 200, capMs: 2000 }

/** Focus roles that take typing: a click landing here is complete in itself. */
const TEXT_FIELD_FOCUS = /^(textbox|searchbox|combobox|textarea|input)\b/
const focusedTextField = (e: ActionEffect): boolean => e.focusChanged && TEXT_FIELD_FOCUS.test(e.focus)
/** Keys that submit or activate — the ones whose effect can arrive late. */
const ACTIVATING_KEYS = new Set(['enter', 'return', 'space', ' '])

export const ACTION_POLICIES: Record<ActionVerb, ActionPolicy> = {
  click: { ...base, verb: 'click', settleMs: 300, countFocus: false, recheck: e => !focusedTextField(e) },
  press: { ...base, verb: 'press', settleMs: 50, countFocus: true, recheck: () => false },
  select: { ...base, verb: 'select', settleMs: 300, countFocus: false, recheck: () => true },
  // A menu opens within the settle or not at all.
  hover: { ...base, verb: 'hover', settleMs: 300, countFocus: false, recheck: () => false },
  // A scroll on a static page changes nothing in the DOM by design; the
  // viewport line already says where the page is.
  scroll: { ...base, verb: 'scroll', settleMs: 300, countFocus: false, recheck: () => false },
}

/**
 * The press policy for one key: Enter and Space submit or activate, so they
 * get a click-sized settle and the recheck; every other key (Tab, Escape,
 * arrows, modifier combos) acts at once or not at all.
 */
export function pressPolicy(key: string): ActionPolicy {
  const activating = ACTIVATING_KEYS.has(key.trim().toLowerCase())
  return { ...ACTION_POLICIES.press, settleMs: activating ? PRESS_ENTER_SETTLE_MS : PRESS_SETTLE_MS, recheck: () => activating }
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
  focusChanged: boolean
  /** The focused field's value after the action, when it changed with focus unchanged (typing, clear). */
  focusValueChanged: boolean
  focusValue: string
  failed: FailedRequest[]
  /** Busy indicators present after the action that were not there before (animations are already "since the action"). */
  busy: BusyIndicator[]
  /** Requests started by the action that had not completed at the last read. */
  pending: number
}

const topKey = (e: TopLayerEntry): string => `${e.kind}|${e.name}`

/** What changed between the two reads. */
export function diffObservations(before: PageObservation, after: PageObservation): ActionEffect {
  const beforeTop = new Set(before.top.map(topKey))
  const afterTop = new Set(after.top.map(topKey))
  const beforeLive = new Set(before.liveRegions)
  const beforeBusy = new Set(before.busy.map(busyKey))
  return {
    opened: after.top.filter(e => !beforeTop.has(topKey(e))),
    closed: before.top.filter(e => !afterTop.has(topKey(e))),
    interactiveDelta: after.interactive - before.interactive,
    stateChanged: after.stateHash !== before.stateHash,
    announced: after.liveRegions.filter(s => !beforeLive.has(s)),
    textChanged: after.contentHash !== before.contentHash && after.contentChars !== before.contentChars,
    textDelta: after.contentChars - before.contentChars,
    focus: after.focus,
    focusChanged: after.focus !== before.focus,
    focusValueChanged: after.focus === before.focus && after.focusValue !== before.focusValue,
    focusValue: after.focusValue,
    failed: after.failed,
    busy: after.busy.filter(b => !beforeBusy.has(busyKey(b))),
    pending: after.pending,
  }
}

/** True when the diff found anything the result will report. */
export function effectHasChange(e: ActionEffect, opts: { countFocus?: boolean } = {}): boolean {
  const countFocus = opts.countFocus ?? true
  return (
    e.opened.length > 0 || e.closed.length > 0 || e.announced.length > 0 || e.failed.length > 0 ||
    e.interactiveDelta !== 0 || e.stateChanged || e.textChanged || (countFocus && (e.focusChanged || e.focusValueChanged))
  )
}

/** The page is still working on the action's consequences. */
export function effectIsBusy(e: ActionEffect): boolean {
  return e.pending > 0 || transientBusy({ busy: e.busy } as PageObservation).length > 0
}

/** Two reads that agree on everything the effect line reports. */
function sameState(a: PageObservation, b: PageObservation): boolean {
  return (
    a.contentHash === b.contentHash && a.contentChars === b.contentChars && a.interactive === b.interactive && a.stateHash === b.stateHash &&
    a.top.map(topKey).join('\n') === b.top.map(topKey).join('\n') &&
    a.liveRegions.join('\n') === b.liveRegions.join('\n') &&
    a.focus === b.focus && a.focusValue === b.focusValue
  )
}

export interface SettleResult {
  before: PageObservation | null
  after: PageObservation | null
  effect: ActionEffect | null
  /** How long after the action the reported state was read. */
  waitedMs: number
  /** The cap was reached while the page was still working. */
  stillBusy: boolean
}

export interface ObserveActionOptions<R> {
  /** Run the action; a failed action (non-zero exit) ends the settle at once. */
  exec: () => Promise<R>
  isFailure: (r: R) => boolean
  /** Run an observer script in the page and return its stdout, or null if it could not run. */
  evalScript: (script: string) => Promise<string | null>
  policy: ActionPolicy
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Before-read (baseline), action, settle, then read until the page is quiet
 * or the cap. No effect is claimed across a navigation — the two documents
 * are not comparable — the caller sees that in `after.url`.
 */
export async function observeAction<R>(opts: ObserveActionOptions<R>): Promise<{ result: R } & SettleResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = opts.now ?? (() => Date.now())
  const { policy } = opts
  const read = async (script: string): Promise<PageObservation | null> => {
    const out = await opts.evalScript(script)
    return out === null ? null : parseObservation(out)
  }

  const before = await read(observerScript({ baseline: true }))
  const result = await opts.exec()
  if (opts.isFailure(result)) return { result, before, after: null, effect: null, waitedMs: 0, stillBusy: false }

  const actedAt = now()
  const elapsed = (): number => now() - actedAt
  const readAfter = (): Promise<PageObservation | null> => read(observerScript({ since: before?.t }))
  const diff = (after: PageObservation | null): ActionEffect | null =>
    before && after && after.url === before.url ? diffObservations(before, after) : null

  await sleep(policy.settleMs)
  let after = await readAfter()
  let effect = diff(after)
  let stillBusy = false

  if (effect && !effectIsBusy(effect) && !effectHasChange(effect, { countFocus: policy.countFocus }) && policy.recheck(effect) && elapsed() < policy.recheckMs) {
    // Silence at the settle: a late effect is the other explanation.
    await sleep(Math.max(0, policy.recheckMs - elapsed()))
    const again = await readAfter()
    if (again) { after = again; effect = diff(again) }
  }
  // The page is working: keep reading until it stops AND two consecutive
  // reads agree, or the cap. A page that was never busy returns at once.
  let wasBusy = false
  let prev: PageObservation | null = null
  while (effect && after) {
    const busyNow = effectIsBusy(effect)
    if (!busyNow && !wasBusy) break
    if (!busyNow && prev && sameState(prev, after)) break
    if (elapsed() >= policy.capMs) { stillBusy = busyNow; break }
    wasBusy = wasBusy || busyNow
    await sleep(Math.min(policy.pollMs, Math.max(0, policy.capMs - elapsed())))
    prev = after
    const again = await readAfter()
    if (!again) break
    after = again
    effect = diff(again)
  }
  return { result, before, after, effect, waitedMs: Math.round(elapsed()), stillBusy }
}

export interface EffectFormatOptions {
  /** How long after the action the reported state was read. */
  settleMs: number
  verb: ActionVerb
  stillBusy?: boolean
}

/** What the observer looks at — named when nothing was seen, so the agent knows the scope of that silence. */
const OBSERVED_SCOPE = 'dialogs, live regions, page text, control state, focus'

/**
 * One line describing the effect. Leads with what a person would notice
 * (dialog opened, announcement, failed request), then the census delta,
 * control state, typed values and focus. When nothing was seen it says so
 * and names what was looked at — no verdict on why. When the page was still
 * active at the cap, it says what was still going and what had landed so far.
 * A scroll that changed nothing gets no line: the viewport line is the fact.
 */
export function formatActionEffect(effect: ActionEffect | null, opts: EffectFormatOptions): string {
  if (!effect) return ''
  const parts: string[] = []
  for (const e of effect.opened) parts.push(`${e.kind}${e.name ? ` ${JSON.stringify(e.name)}` : ''} opened`)
  for (const e of effect.closed) parts.push(`${e.kind}${e.name ? ` ${JSON.stringify(e.name)}` : ''} closed`)
  if (effect.announced.length > 0) parts.push(`announced: ${effect.announced.map(s => JSON.stringify(s)).join(' | ')}`)
  for (const f of effect.failed.slice(0, 3)) {
    parts.push(`failed request: ${f.initiator ? `${f.initiator} ` : ''}${f.url} → ${f.status > 0 ? f.status : 'network error'}`)
  }
  if (effect.interactiveDelta !== 0) {
    parts.push(`${effect.interactiveDelta > 0 ? '+' : ''}${effect.interactiveDelta} interactive elements`)
  } else if (parts.length === 0 && effect.textChanged) {
    const d = effect.textDelta
    parts.push(`page text changed (${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')} chars)`)
  }
  if (effect.stateChanged) parts.push('control state changed (checked/pressed/expanded/selected)')
  if (effect.focusValueChanged) parts.push(`field value now ${JSON.stringify(effect.focusValue)}`)
  // Focus is a fact worth a few chars: for a press it is where the next key
  // goes; for a click it shows which element took the click.
  const focusNote = effect.focus && (opts.verb === 'press' || (opts.verb === 'click' && effect.focusChanged)) ? `focus: ${effect.focus}` : ''
  const busy = opts.stillBusy ? describeBusy(effect.busy, effect.pending) : ''
  const window = `${(opts.settleMs / 1000).toFixed(1)}s`
  if (busy) {
    const so_far = parts.length > 0 ? ` So far: ${parts.join(' · ')}.` : ''
    return `\nEffect: page still active after ${window} (${busy}).${so_far}${focusNote ? ` (${focusNote})` : ''}`
  }
  if (parts.length === 0) {
    if (opts.verb === 'scroll') return ''
    if (focusNote && effect.focusChanged) return `\nEffect: ${focusNote}`
    return `\nEffect: none observed within ${opts.settleMs}ms (${OBSERVED_SCOPE})${focusNote ? ` — ${focusNote}` : ''}`
  }
  if (focusNote) parts.push(focusNote)
  return `\nEffect: ${parts.join(' · ')}`
}
