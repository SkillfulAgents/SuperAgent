/**
 * request_login's browser side: locate the fields the agent mapped by ref,
 * and later write the user's values into them.
 *
 * agent-browser resolves refs (in any frame, falling back to role and name
 * for a stale one) but cannot hand us the element, so a ref is located by
 * focusing it through the CLI and following focus over our own CDP
 * connection. Focus can stay where it was (an element that cannot take it)
 * or be moved by the page, so the focused element must also sit exactly
 * where the CLI says the ref's element is.
 */
import { callOnElement, callOnElementWith, locateFocusedElement, type CdpConnection, type CdpEvent, type LocatedElement } from './login-cdp'
import {
  CLICK_IN_PAGE_FUNCTION,
  FILL_PAGE_STATE_FUNCTION,
  HOLDS_VALUE_FUNCTION,
  LOGIN_FIELD_INPUT_TYPES,
  SECRET_LOGIN_FIELD_KINDS,
  STILL_FOCUSED_FUNCTION,
  WRITE_FIELD_FUNCTION,
  type FieldBox,
  type FillPageState,
  type FocusedElementDescription,
  type HeldState,
  type LoginFieldKind,
  type WriteFieldResult,
} from './login-form-script'

export interface LoginFieldRequest {
  ref: string
  kind: LoginFieldKind
  label: string
}

export interface PreparedLoginField extends LoginFieldRequest {
  /** The page input's type: 'email', 'password', 'textarea', … */
  inputType: string
  inputMode: string
  autocomplete: string
  maxLength: number
}

export interface PreparedLogin {
  toolUseId: string
  sessionId: string
  /** The origin of the frame that holds the fields. */
  origin: string
  /** That frame's URL when the fields were located. */
  url: string
  /** The origin of the page's main frame; differs when the form is in a frame of another site. */
  topOrigin: string
  fields: PreparedLoginField[]
  submitRef: string | null
  preparedAt: number
}

export interface LoginFillDeps {
  /** Focus the element a ref names; the CLI's error text, or null. */
  focusRef(ref: string): Promise<string | null>
  /** The ref's border box in its own frame's viewport, or null when the CLI could not read it. */
  boxOfRef(ref: string): Promise<FieldBox | null>
  /** Whether the ref's element is enabled, or null when the CLI could not say. */
  isEnabled?(ref: string): Promise<boolean | null>
  /** A CDP connection to the page the refs belong to. */
  connect(): Promise<CdpConnection>
  /** Pause before re-measuring a ref whose box did not match (a focus scroll still moving it). */
  remeasureMs?: number
}

export type FieldStatus = 'filled' | 'changed' | 'skipped' | 'failed'

export interface FieldOutcome {
  ref: string
  kind: LoginFieldKind
  label: string
  status: FieldStatus
  /** What was observed when the field could not be written. */
  problem?: string
  /** Split code boxes the value was typed across. */
  boxes?: number
}

export interface WrittenField {
  index: number
  kind: LoginFieldKind
  element: LocatedElement
  value: string
  kept: boolean
  boxes?: number
  /** When its write was sent: what the page does from here on is a reaction to it. */
  startedAt: number
}

const BOX_TOLERANCE_PX = 2

const KIND_NAMES: Record<LoginFieldKind, string> = {
  username: 'a username',
  password: 'a password',
  otp: 'a one-time code',
  text: 'text',
}

function sameBox(a: FieldBox, b: FieldBox): boolean {
  return Math.abs(a.x - b.x) <= BOX_TOLERANCE_PX &&
    Math.abs(a.y - b.y) <= BOX_TOLERANCE_PX &&
    Math.abs(a.width - b.width) <= BOX_TOLERANCE_PX &&
    Math.abs(a.height - b.height) <= BOX_TOLERANCE_PX
}

/** `<input type=email>`, `<textarea>`, `<button>` — how a field reads in a problem. */
export function describeElement(description: Pick<FocusedElementDescription, 'tag' | 'type'>): string {
  if (description.tag === 'input') return `<input type=${description.type}>`
  return `<${description.tag}>`
}

function listTypes(kind: LoginFieldKind): string {
  const types = LOGIN_FIELD_INPUT_TYPES[kind].map((type) => (type === 'textarea' ? '<textarea>' : type))
  return types.length === 1 ? `a ${types[0]} input` : `a ${types.slice(0, -1).join(', ')} or ${types[types.length - 1]} input`
}

/** A field's problem for the agent, as an observation. */
function kindProblem(field: LoginFieldRequest, description: FocusedElementDescription): string | null {
  if (!LOGIN_FIELD_INPUT_TYPES[field.kind].includes(description.type)) {
    return `${field.ref} is ${describeElement(description)}; ${KIND_NAMES[field.kind]} goes into ${listTypes(field.kind)}`
  }
  if (!description.rendered) return `${field.ref} is not visible`
  if (description.disabled) return `${field.ref} is disabled`
  if (description.readOnly) return `${field.ref} is read-only`
  return null
}

/**
 * Locate the element a ref names: focus it through the CLI, find what has
 * focus, and check that it sits where the CLI says the ref's element is.
 * A mismatch is measured again once after a pause — focusing can scroll the
 * page smoothly, and the two measures may straddle the scroll.
 */
export async function locateRef(
  deps: LoginFillDeps,
  cdp: CdpConnection,
  ref: string,
): Promise<{ element: LocatedElement; box: FieldBox } | { problem: string }> {
  const focusError = await deps.focusRef(ref)
  if (focusError) return { problem: `${ref} could not be focused: ${focusError}` }
  // Focus stays where it was when the element cannot take it.
  const disabled = async () => (await deps.isEnabled?.(ref)) === false
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, deps.remeasureMs ?? 300))
    const box = await deps.boxOfRef(ref)
    if (!box) return { problem: `the box of ${ref} could not be read` }
    const located = await locateFocusedElement(cdp)
    if ('missed' in located) {
      if (located.missed === 'frame_unreachable') return { problem: `after focusing ${ref}, focus is in a frame that could not be reached` }
      if (await disabled()) return { problem: `${ref} is disabled` }
      return { problem: `after focusing ${ref}, no element has focus` }
    }
    if (sameBox(located.description.box, box)) return { element: located, box }
    if (attempt === 1) {
      if (await disabled()) return { problem: `${ref} is disabled` }
      return { problem: `after focusing ${ref}, focus is on ${describeElement(located.description)} at a different position than ${ref}` }
    }
  }
  return { problem: `${ref} could not be located` }
}

export type PrepareResult =
  | { ok: true; origin: string; url: string; topOrigin: string; fields: PreparedLoginField[] }
  | { ok: false; problems: string[] }

/**
 * Check every mapped field before the user is asked: it exists, takes its
 * kind of value, and all of them sit in one frame origin — the origin the
 * user is shown and the only one the values are ever written to.
 */
export async function prepareLogin(deps: LoginFillDeps, fields: LoginFieldRequest[]): Promise<PrepareResult> {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const field of fields) {
    if (seen.has(field.ref)) problems.push(`${field.ref} is mapped more than once`)
    seen.add(field.ref)
  }
  if (problems.length) return { ok: false, problems }

  const cdp = await deps.connect()
  try {
    const prepared: PreparedLoginField[] = []
    const origins = new Map<string, string[]>()
    let url = ''
    let topOrigin = ''
    for (const field of fields) {
      const located = await locateRef(deps, cdp, field.ref)
      if ('problem' in located) {
        problems.push(located.problem)
        continue
      }
      const { description } = located.element
      if (description.appPage) {
        // Signing the agent's browser in to the app would hand it the user's session there.
        return { ok: false, problems: [`the fields are on a page of this app itself (${description.origin}), which request_login never fills`] }
      }
      const problem = kindProblem(field, description)
      if (problem) {
        problems.push(problem)
        continue
      }
      origins.set(description.origin, [...(origins.get(description.origin) ?? []), field.ref])
      url ||= description.url
      topOrigin ||= located.element.topOrigin
      prepared.push({
        ...field,
        inputType: description.type,
        inputMode: description.inputMode,
        autocomplete: description.autocomplete,
        maxLength: description.maxLength,
      })
    }
    if (problems.length) return { ok: false, problems }
    if (origins.size > 1) {
      const where = [...origins].map(([origin, refs]) => `${refs.join(', ')} on ${origin}`).join('; ')
      return { ok: false, problems: [`the fields are in frames of different origins (${where})`] }
    }
    const origin = [...origins.keys()][0]
    if (!/^https?:\/\//.test(origin)) {
      return { ok: false, problems: [`the fields' frame has the origin "${origin}", which is not a web site`] }
    }
    return { ok: true, origin, url, topOrigin: topOrigin || origin, fields: prepared }
  } finally {
    cdp.close()
  }
}

/**
 * A code as typed from an SMS or an app ("123 456", "123-456") into a field
 * that takes the bare code: spaces always go; hyphens go for a numeric field.
 */
export function normalizeCode(value: string, field: Pick<PreparedLoginField, 'inputType' | 'inputMode'>): string {
  const compact = value.replace(/\s+/g, '')
  const numeric = field.inputType === 'number' || field.inputType === 'tel' || field.inputMode === 'numeric'
  return numeric ? compact.replace(/-/g, '') : compact
}

/** A navigation, or a script's request, seen in the page. */
export interface PageEvent {
  at: number
  frameId: string
  kind: 'navigation' | 'request'
  method?: string
  url: string
  /** A request's CDP id and session, to fetch a body the event left out. */
  requestId?: string
  sessionId?: string
  /** A request's body, held only to look for the code in it; never reported. */
  body?: string | null
}

/** A URL without its query and fragment, which can carry what was typed. */
export function withoutQuery(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split(/[?#]/)[0]
  }
}

/** Whether `text` carries `code` — for a digit code, not inside a longer number. */
function carries(text: string | null | undefined, code: string): boolean {
  if (!text || !code) return false
  if (!/^\d+$/.test(code)) return text.includes(code)
  return new RegExp(`(?<!\\d)${code}(?!\\d)`).test(text)
}

/**
 * What the page does around a fill, over our own CDP connection: navigations
 * of its frames, and its scripts' requests (a code the page verifies by
 * fetch as its last digit goes in, without a submit event). Watched from
 * before the first write until the submit, so a page that moved on by itself
 * is not submitted a second time.
 */
export class PageWatch {
  private readonly events: PageEvent[] = []
  private readonly sessions = new Set<string>()
  private readonly unsubscribe: () => void

  private constructor(private readonly cdp: CdpConnection, readonly mainFrameId: string) {
    this.unsubscribe = cdp.onEvent((event) => this.record(event))
  }

  static async start(cdp: CdpConnection): Promise<PageWatch> {
    const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, cdp.pageSession)
    const watch = new PageWatch(cdp, tree.frameTree.frame.id)
    await watch.cover(cdp.pageSession)
    return watch
  }

  /** Watch a session too: the out-of-process frame a field is in. */
  async cover(sessionId: string | undefined): Promise<void> {
    const key = sessionId ?? ''
    if (this.sessions.has(key)) return
    this.sessions.add(key)
    // A session that refuses a domain still gets the in-page checks.
    await Promise.all([
      this.cdp.send('Page.enable', {}, sessionId),
      this.cdp.send('Network.enable', {}, sessionId),
    ]).catch(() => {})
  }

  /** The first navigation of one of `frameIds` at or after `since`. */
  navigation(frameIds: string[], since: number): PageEvent | undefined {
    return this.events.find((event) => event.kind === 'navigation' && event.at >= since && frameIds.includes(event.frameId))
  }

  /**
   * The first script request at or after `since` that carries `code` in its
   * URL or body: the page sending the code itself. Telemetry and other calls
   * a page makes as fields change do not carry it.
   */
  async requestCarrying(code: string, since: number): Promise<PageEvent | undefined> {
    for (const event of this.events) {
      if (event.kind !== 'request' || event.at < since) continue
      if (carries(event.url, code)) return event
      if (event.body === undefined && event.requestId) {
        // Left out of the event (a large or streamed body): ask for it.
        const fetched = await this.cdp.send<{ postData?: string }>('Network.getRequestPostData', { requestId: event.requestId }, event.sessionId)
          .catch(() => ({ postData: undefined }))
        event.body = fetched.postData ?? null
      }
      if (carries(event.body, code)) return event
    }
    return undefined
  }

  close(): void {
    this.unsubscribe()
    // Bodies can hold what was typed: keep them no longer than the fill.
    this.events.length = 0
  }

  private record({ method, params, sessionId }: CdpEvent): void {
    if (!this.sessions.has(sessionId ?? '')) return
    const at = Date.now()
    if (method === 'Page.frameRequestedNavigation' || method === 'Page.frameStartedLoading') {
      this.events.push({ at, frameId: String(params.frameId), kind: 'navigation', url: typeof params.url === 'string' ? params.url : '' })
    } else if (method === 'Network.requestWillBeSent') {
      const request = params.request ?? {}
      const url = typeof request.url === 'string' ? request.url : ''
      if (params.type === 'Document') {
        this.events.push({ at, frameId: String(params.frameId), kind: 'navigation', url })
      } else if (params.type === 'XHR' || params.type === 'Fetch') {
        this.events.push({
          at,
          frameId: String(params.frameId),
          kind: 'request',
          method: String(request.method ?? 'GET').toUpperCase(),
          url,
          requestId: typeof params.requestId === 'string' ? params.requestId : undefined,
          sessionId,
          // No body at all, or one to fetch on demand.
          body: typeof request.postData === 'string' ? request.postData : request.hasPostData ? undefined : null,
        })
      }
    }
  }
}

/**
 * Write the user's values into the prepared fields, in order. Each write
 * re-checks the frame's origin, the element's identity and its type in the
 * same task as the write. Stops at a frame that changed origin.
 * `values[i]` belongs to `prepared.fields[i]`; an empty value skips the field.
 * `pageValues` are secrets as the page rewrote them, for redaction only.
 * `beforeWrite` runs once a field is located, with the value exactly as it
 * will be written (a code without its spaces), before it is sent.
 */
export async function fillLogin(
  deps: LoginFillDeps,
  cdp: CdpConnection,
  prepared: Pick<PreparedLogin, 'origin' | 'fields'>,
  values: string[],
  fillId: string,
  beforeWrite?: (field: PreparedLoginField, element: LocatedElement, value: string) => Promise<void> | void,
): Promise<{ outcomes: FieldOutcome[]; written: WrittenField[]; pageValues: string[] }> {
  const outcomes: FieldOutcome[] = []
  const written: WrittenField[] = []
  const pageValues: string[] = []
  let stopped: string | null = null
  for (const [index, field] of prepared.fields.entries()) {
    const base = { ref: field.ref, kind: field.kind, label: field.label }
    const raw = values[index] ?? ''
    const value = field.kind === 'otp' ? normalizeCode(raw, field) : raw
    if (stopped) {
      outcomes.push({ ...base, status: 'failed', problem: stopped })
      continue
    }
    if (!value) {
      outcomes.push({ ...base, status: 'skipped' })
      continue
    }
    const located = await locateRef(deps, cdp, field.ref)
    if ('problem' in located) {
      outcomes.push({ ...base, status: 'failed', problem: located.problem })
      continue
    }
    if (located.element.description.origin !== prepared.origin) {
      stopped = `the frame holding the fields is now on ${located.element.description.origin}, not ${prepared.origin}`
      outcomes.push({ ...base, status: 'failed', problem: stopped })
      continue
    }
    await beforeWrite?.(field, located.element, value)
    const startedAt = Date.now()
    let result: WriteFieldResult
    try {
      result = await callOnElement<WriteFieldResult>(cdp, located.element, WRITE_FIELD_FUNCTION, [
        value,
        prepared.origin,
        field.kind,
        LOGIN_FIELD_INPUT_TYPES[field.kind],
        located.box,
        SECRET_LOGIN_FIELD_KINDS.has(field.kind),
        fillId,
      ])
    } catch (error) {
      // The call can fail after the page ran it (a timeout): say what failed, not what the page did.
      outcomes.push({ ...base, status: 'failed', problem: `the write into ${field.ref} returned no answer (${cdpErrorText(error)})` })
      continue
    }
    if (!result?.ok) {
      const problem = writeProblem(field.ref, result)
      if (result?.reason === 'origin_changed') stopped = problem
      outcomes.push({ ...base, status: 'failed', problem })
      continue
    }
    if (result.pageValue) pageValues.push(result.pageValue)
    written.push({ index, kind: field.kind, element: located.element, value, kept: result.kept, boxes: result.boxes, startedAt })
    outcomes.push({ ...base, status: result.kept ? 'filled' : 'changed', ...(result.boxes ? { boxes: result.boxes } : {}) })
  }
  return { outcomes, written, pageValues }
}

function writeProblem(ref: string, result: Extract<WriteFieldResult, { ok: false }> | undefined): string {
  switch (result?.reason) {
    case 'origin_changed': return `the frame holding ${ref} is now on ${result.origin}`
    case 'detached': return `${ref} was removed from the page`
    case 'wrong_type': return `${ref} is now an input of type ${result.type}`
    case 'not_editable': return `${ref} is disabled or read-only`
    case 'not_visible': return `${ref} is not visible`
    case 'not_the_field': return `${ref} moved while it was being filled`
    case 'otp_boxes': return `${ref} takes one character, and fewer one-character boxes follow it than the code has characters`
    default: return `the page did not accept the write into ${ref}`
  }
}

/** A CDP error as a short reason, without arguments (the connection never puts values in them). */
function cdpErrorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160)
}

/** Errors that mean the element's script context went away with its document or frame. */
const CONTEXT_GONE = /cannot find context|execution context was destroyed|could not find object|frame detached|inspected target navigated/i

export type ReadBack =
  | { index: number; state: HeldState }
  | { index: number; state: 'unreadable'; error: string }

/**
 * What became of each written field just before submitting, read from the
 * nodes the write typed into — also a field that read differently right
 * after its write, which may have taken the value since.
 */
export async function heldStates(cdp: CdpConnection, written: WrittenField[]): Promise<ReadBack[]> {
  const states: ReadBack[] = []
  for (const field of written) {
    try {
      const state = await callOnElement<HeldState>(cdp, field.element, HOLDS_VALUE_FUNCTION, [
        field.value,
        field.kind,
        LOGIN_FIELD_INPUT_TYPES[field.kind],
      ])
      states.push({ index: field.index, state })
    } catch (error) {
      states.push({ index: field.index, state: 'unreadable', error: cdpErrorText(error) })
    }
  }
  return states
}

/** What the page did by itself after the values went in, seen before anything was clicked or pressed. */
export type PageActivity =
  | { kind: 'submit' }
  | { kind: 'navigation'; url: string }
  | { kind: 'request'; method: string; url: string }
  | { kind: 'detached'; ref: string }
  /** Disabled or read-only since the write: the page is busy with the values. */
  | { kind: 'locked'; ref: string }
  | { kind: 'gone' }
  | { kind: 'unreadable'; error: string }

/**
 * Whether the page has moved on by itself since the fill: a navigation of
 * the fields' frame or the page; for a code, a state-changing request from
 * the frame after its write (a code verified by fetch on its last digit); a
 * submit event in the fields' document; or the last field gone from it.
 * `refOf` names a written field for the report.
 */
export async function pageActivityNow(
  cdp: CdpConnection,
  written: WrittenField[],
  fillId: string,
  watch: PageWatch,
  refOf: (field: WrittenField) => string,
): Promise<PageActivity | null> {
  const last = written[written.length - 1]
  if (!last) return null
  const navigation = watch.navigation([watch.mainFrameId, last.element.frameId], written[0].startedAt)
  if (navigation) return { kind: 'navigation', url: navigation.url }
  if (last.kind === 'otp') {
    const request = await watch.requestCarrying(last.value, last.startedAt)
    if (request) return { kind: 'request', method: request.method ?? 'POST', url: withoutQuery(request.url) }
  }
  try {
    const state = await callOnElement<FillPageState>(cdp, last.element, FILL_PAGE_STATE_FUNCTION, [fillId])
    if (state?.submitted) return { kind: 'submit' }
    if (state && !state.connected) return { kind: 'detached', ref: refOf(last) }
    return null
  } catch (error) {
    return CONTEXT_GONE.test(cdpErrorText(error)) ? { kind: 'gone' } : { kind: 'unreadable', error: cdpErrorText(error) }
  }
}

/**
 * Watch the page for `waitMs` after the fill (a code field may submit itself
 * on its last character, at once or after a debounce), returning as soon as
 * it moves on by itself.
 */
export async function awaitPageActivity(
  cdp: CdpConnection,
  written: WrittenField[],
  fillId: string,
  watch: PageWatch,
  refOf: (field: WrittenField) => string,
  waitMs: number,
): Promise<PageActivity | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const seen = await pageActivityNow(cdp, written, fillId, watch, refOf)
    if (seen || Date.now() >= deadline) return seen
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
  }
}

/**
 * Click the submit control from inside the page — for a button a banner
 * covers, where the CLI refuses the click. Located like a field, and only
 * clicked while its frame is still on the expected origin and the last field
 * filled is still there to see, in the same document.
 */
export async function clickSubmitInPage(
  deps: LoginFillDeps,
  cdp: CdpConnection,
  submitRef: string,
  origin: string,
  written: WrittenField[],
): Promise<boolean> {
  const kept = written.filter((field) => field.kept)
  const anchor = kept[kept.length - 1]
  if (!anchor) return false
  const located = await locateRef(deps, cdp, submitRef)
  if ('problem' in located || located.element.description.origin !== origin) return false
  const clicked = await callOnElementWith<string>(cdp, located.element, anchor.element, CLICK_IN_PAGE_FUNCTION, [origin]).catch(() => null)
  return clicked === 'clicked'
}

/** Whether Enter pressed now would land in the last field written (any of its code boxes), on the expected origin. */
export async function lastFieldHasFocus(cdp: CdpConnection, written: WrittenField[], origin: string): Promise<boolean> {
  const last = written[written.length - 1]
  if (!last) return false
  return callOnElement<boolean>(cdp, last.element, STILL_FOCUSED_FUNCTION, [origin]).catch(() => false)
}
