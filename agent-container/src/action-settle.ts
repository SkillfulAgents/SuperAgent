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
 */
import { observerScript, parseObservation, type PageObservation, type TopLayerEntry } from './page-observer'
import { PRESS_ENTER_SETTLE_MS, PRESS_SETTLE_MS } from './browser-digest'

export type ActionVerb = 'click' | 'press' | 'select' | 'hover'

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

/** Focus roles that take typing: a click landing here is complete in itself. */
const TEXT_FIELD_FOCUS = /^(textbox|searchbox|combobox|textarea|input)\b/
const focusedTextField = (e: ActionEffect): boolean => e.focusChanged && TEXT_FIELD_FOCUS.test(e.focus)
/** Keys that submit or activate — the ones whose effect can arrive late. */
const ACTIVATING_KEYS = new Set(['enter', 'return', 'space', ' '])

export const ACTION_POLICIES: Record<ActionVerb, ActionPolicy> = {
  click: { verb: 'click', settleMs: 300, recheckMs: RECHECK_MS, countFocus: false, recheck: e => !focusedTextField(e) },
  press: { verb: 'press', settleMs: PRESS_SETTLE_MS, recheckMs: RECHECK_MS, countFocus: true, recheck: () => false },
  select: { verb: 'select', settleMs: 300, recheckMs: RECHECK_MS, countFocus: false, recheck: () => true },
  // A menu opens within the settle or not at all.
  hover: { verb: 'hover', settleMs: 300, recheckMs: RECHECK_MS, countFocus: false, recheck: () => false },
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
  /** Focus is on a different element — by identity, not only by display name (two unnamed inputs are two elements). */
  focusChanged: boolean
  /** The focused field's full value differs, with focus on the same element (typing, clear). Detected on a hash of the whole value, not the preview. */
  focusValueChanged: boolean
  /** Preview of the value (capped by the observer) and the full value's length. */
  focusValue: string
  focusValueChars: number
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
    announced: after.liveRegions.filter(s => !beforeLive.has(s)),
    textChanged: after.contentHash !== before.contentHash && after.contentChars !== before.contentChars,
    textDelta: after.contentChars - before.contentChars,
    focus: after.focus,
    focusChanged: after.focus !== before.focus || after.focusId !== before.focusId,
    focusValueChanged: after.focus === before.focus && after.focusId === before.focusId && after.focusValueHash !== before.focusValueHash,
    focusValue: after.focusValue,
    focusValueChars: after.focusValueChars,
  }
}

/** True when the diff found anything the result will report. */
export function effectHasChange(e: ActionEffect, opts: { countFocus?: boolean } = {}): boolean {
  const countFocus = opts.countFocus ?? true
  return (
    e.opened.length > 0 || e.closed.length > 0 || e.announced.length > 0 ||
    e.interactiveDelta !== 0 || e.stateChanged || e.textChanged || (countFocus && (e.focusChanged || e.focusValueChanged))
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
  const result = await opts.exec()
  if (opts.isFailure(result)) return { result, before, after: null, effect: null, waitedMs: 0 }

  const actedAt = now()
  const elapsed = (): number => now() - actedAt
  const diff = (after: PageObservation | null): ActionEffect | null =>
    before && after && after.url === before.url ? diffObservations(before, after) : null

  await sleep(policy.settleMs)
  let after = await read()
  let effect = diff(after)

  if (effect && !effectHasChange(effect, { countFocus: policy.countFocus }) && policy.recheck(effect) && elapsed() < policy.recheckMs) {
    // Silence at the settle: a late effect is the other explanation.
    await sleep(Math.max(0, policy.recheckMs - elapsed()))
    const again = await read()
    if (again) { after = again; effect = diff(again) }
  }
  return { result, before, after, effect, waitedMs: Math.round(elapsed()) }
}

export interface EffectFormatOptions {
  /** How long after the action the reported state was read. */
  settleMs: number
  verb: ActionVerb
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
  const parts: string[] = []
  for (const e of effect.opened) parts.push(`${e.kind}${e.name ? ` ${JSON.stringify(e.name)}` : ''} opened`)
  for (const e of effect.closed) parts.push(`${e.kind}${e.name ? ` ${JSON.stringify(e.name)}` : ''} closed`)
  if (effect.announced.length > 0) parts.push(`announced: ${effect.announced.map(s => JSON.stringify(s)).join(' | ')}`)
  if (effect.interactiveDelta !== 0) {
    parts.push(`${effect.interactiveDelta > 0 ? '+' : ''}${effect.interactiveDelta} interactive elements`)
  } else if (parts.length === 0 && effect.textChanged) {
    const d = effect.textDelta
    parts.push(`page text changed (${d > 0 ? '+' : '−'}${Math.abs(d).toLocaleString('en-US')} chars)`)
  }
  if (effect.stateChanged) parts.push('control state changed (checked/pressed/expanded/selected)')
  if (effect.focusValueChanged) {
    const preview = effect.focusValue.length < effect.focusValueChars
    parts.push(`field value now ${JSON.stringify(effect.focusValue)}${preview ? ` (${effect.focusValueChars} chars, first ${effect.focusValue.length} shown)` : ''}`)
  }
  // Focus is a fact worth a few chars: for a press it is where the next key
  // goes; for a click it shows which element took the click.
  const focusNote = effect.focus && (opts.verb === 'press' || (opts.verb === 'click' && effect.focusChanged)) ? `focus: ${effect.focus}` : ''
  if (parts.length === 0) {
    if (focusNote && effect.focusChanged) return `\nEffect: ${focusNote}`
    return `\nEffect: none observed within ${opts.settleMs}ms (${OBSERVED_SCOPE})${focusNote ? ` — ${focusNote}` : ''}`
  }
  if (focusNote) parts.push(focusNote)
  return `\nEffect: ${parts.join(' · ')}`
}
