import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CdpConnection, CdpEvent, LocatedElement } from './login-cdp'
import {
  CLICK_IN_PAGE_FUNCTION,
  FILL_PAGE_STATE_FUNCTION,
  HOLDS_VALUE_FUNCTION,
  STILL_FOCUSED_FUNCTION,
  WRITE_FIELD_FUNCTION,
  type FieldBox,
  type FillPageState,
  type FocusedElementDescription,
  type HeldState,
  type WriteFieldResult,
} from './login-form-script'

vi.mock('./login-cdp', () => ({ locateFocusedElement: vi.fn(), callOnElement: vi.fn(), callOnElementWith: vi.fn() }))
const cdpModule = await import('./login-cdp')
const {
  awaitPageActivity, clickSubmitInPage, fillLogin, heldStates, lastFieldHasFocus, normalizeCode, pageActivityNow, PageWatch, prepareLogin,
} = await import('./login-fill')

/** A fake page: what each ref is, where it sits, and what focusing it does. */
interface FakeElement {
  description: Partial<FocusedElementDescription>
  box?: FieldBox
  /** Focusing this ref leaves focus on another ref (non-focusable, or a redirect). */
  focusGoesTo?: string
  focusError?: string
  enabled?: boolean
  write?: WriteFieldResult | 'throw'
  held?: HeldState | 'throw'
  /** The page state the fill's world reports, or the CDP error the call fails with. */
  state?: FillPageState | { error: string }
  clicked?: string
  focused?: boolean
}

const BOX: FieldBox = { x: 10, y: 10, width: 200, height: 30 }

function element(type: string, extra: Partial<FocusedElementDescription> = {}): FakeElement['description'] {
  return {
    tag: type === 'button' ? 'button' : 'input', type, isFrame: false, origin: 'https://github.com',
    url: 'https://github.com/login', rendered: true, disabled: false, readOnly: false,
    inputMode: '', autocomplete: '', maxLength: -1, ...extra,
  }
}

let page: Record<string, FakeElement>
let focused: string | null
/** A box the CLI reports once before settling on the element's real box (a smooth scroll). */
let scrollingRef: string | null
const writes: Array<{ ref: string; args: unknown[] }> = []
const cdp = { close: vi.fn() } as unknown as CdpConnection

const deps = {
  focusRef: vi.fn(async (ref: string) => {
    const el = page[ref]
    if (!el) return '✗ Unknown ref: ' + ref.slice(1)
    if (el.focusError) return el.focusError
    focused = el.focusGoesTo ?? ref
    return null
  }),
  boxOfRef: vi.fn(async (ref: string) => {
    if (!page[ref]) return null
    if (scrollingRef === ref) {
      scrollingRef = null
      return { ...(page[ref].box ?? BOX), y: 500 }
    }
    return page[ref].box ?? BOX
  }),
  isEnabled: vi.fn(async (ref: string) => page[ref]?.enabled ?? null),
  connect: vi.fn(async () => cdp),
  remeasureMs: 0,
}

beforeEach(() => {
  page = {}
  focused = null
  scrollingRef = null
  writes.length = 0
  vi.mocked(cdp.close).mockClear()
  deps.focusRef.mockClear()
  deps.boxOfRef.mockClear()
  deps.isEnabled.mockClear()
  deps.connect.mockClear()
  vi.mocked(cdpModule.locateFocusedElement).mockImplementation(async () => {
    if (!focused) return { missed: 'nothing_focused' }
    const el = page[focused]
    return {
      sessionId: undefined,
      objectId: `obj:${focused}`,
      frameId: 'F0',
      description: { box: el.box ?? BOX, ...el.description } as FocusedElementDescription,
      topOrigin: 'https://github.com',
    }
  })
  vi.mocked(cdpModule.callOnElement).mockImplementation(async (_cdp, located: Pick<LocatedElement, 'objectId'>, fn: string, args: unknown[]) => {
    const ref = located.objectId.slice(4)
    const el = page[ref]
    if (fn === WRITE_FIELD_FUNCTION) {
      writes.push({ ref, args })
      if (el.write === 'throw') throw new Error('The page function threw')
      return (el.write ?? { ok: true, kept: true }) as never
    }
    if (fn === HOLDS_VALUE_FUNCTION) {
      if (el.held === 'throw') throw new Error('Runtime.callFunctionOn: timed out')
      return (el.held ?? 'held') as never
    }
    if (fn === FILL_PAGE_STATE_FUNCTION) {
      if (el.state && 'error' in el.state) throw new Error(el.state.error)
      return (el.state ?? { submitted: false, connected: true, origin: 'https://github.com' }) as never
    }
    if (fn === STILL_FOCUSED_FUNCTION) return (el.focused ?? true) as never
    throw new Error('unexpected page function')
  })
  inPageClicks.length = 0
  vi.mocked(cdpModule.callOnElementWith).mockImplementation(async (_cdp, located, other, fn: string) => {
    if (located.frameId !== other.frameId) throw new Error('The elements are in different frames')
    if (fn !== CLICK_IN_PAGE_FUNCTION) throw new Error('unexpected page function')
    const ref = located.objectId.slice(4)
    inPageClicks.push({ ref, with: other.objectId.slice(4) })
    return (page[ref].clicked ?? 'clicked') as never
  })
})

/** In-page clicks: the button's ref, and the field the click was bound to. */
const inPageClicks: Array<{ ref: string; with: string }> = []

const fields = [
  { ref: '@e3', kind: 'username' as const, label: 'Username or email address' },
  { ref: '@e6', kind: 'password' as const, label: 'Password' },
]

describe('prepareLogin', () => {
  it('locates each field and reports the origin of the frame holding them and of the page', async () => {
    page['@e3'] = { description: element('text', { autocomplete: 'username' }) }
    page['@e6'] = { description: element('password'), box: { ...BOX, y: 60 } }
    const result = await prepareLogin(deps, fields)
    expect(result).toEqual({
      ok: true,
      origin: 'https://github.com',
      url: 'https://github.com/login',
      topOrigin: 'https://github.com',
      fields: [
        { ...fields[0], inputType: 'text', inputMode: '', autocomplete: 'username', maxLength: -1 },
        { ...fields[1], inputType: 'password', inputMode: '', autocomplete: '', maxLength: -1 },
      ],
    })
    expect(cdp.close).toHaveBeenCalled()
  })

  it('refuses a ref mapped twice before touching the page', async () => {
    const result = await prepareLogin(deps, [fields[0], { ...fields[1], ref: '@e3' }])
    expect(result).toEqual({ ok: false, problems: ['@e3 is mapped more than once'] })
    expect(deps.connect).not.toHaveBeenCalled()
  })

  it('refuses a field whose kind the element cannot take', async () => {
    page['@e3'] = { description: element('email') }
    page['@e6'] = { description: element('email'), box: { ...BOX, y: 60 } }
    const result = await prepareLogin(deps, fields)
    expect(result).toEqual({ ok: false, problems: ['@e6 is <input type=email>; a password goes into a password input'] })
  })

  it('refuses a ref whose focus lands elsewhere (non-focusable element or a focus redirect)', async () => {
    page['@e3'] = { description: element('text') }
    page['@e9'] = { description: element('text'), box: { ...BOX, y: 300 }, focusGoesTo: '@e3' }
    const result = await prepareLogin(deps, [{ ref: '@e9', kind: 'username', label: 'User' }])
    expect(result).toEqual({ ok: false, problems: ['after focusing @e9, focus is on <input type=text> at a different position than @e9'] })
  })

  it('names a disabled field when focus could not reach it', async () => {
    page['@e3'] = { description: element('text') }
    page['@e9'] = { description: element('password'), box: { ...BOX, y: 300 }, focusGoesTo: '@e3', enabled: false }
    const result = await prepareLogin(deps, [{ ref: '@e9', kind: 'password', label: 'Password' }])
    expect(result).toEqual({ ok: false, problems: ['@e9 is disabled'] })
  })

  it('measures again once when the box moved under a scroll, and then finds the field', async () => {
    page['@e3'] = { description: element('text') }
    scrollingRef = '@e3'
    const result = await prepareLogin(deps, [fields[0]])
    expect(result.ok).toBe(true)
    expect(deps.boxOfRef).toHaveBeenCalledTimes(2)
  })

  it('reports the CLI\'s error for a ref it cannot resolve', async () => {
    const result = await prepareLogin(deps, [{ ref: '@e40', kind: 'username', label: 'User' }])
    expect(result).toEqual({ ok: false, problems: ['@e40 could not be focused: ✗ Unknown ref: e40'] })
  })

  it('says what it found when nothing has focus, or the frame could not be reached', async () => {
    page['@e3'] = { description: element('text') }
    vi.mocked(cdpModule.locateFocusedElement).mockResolvedValueOnce({ missed: 'nothing_focused' })
    expect(await prepareLogin(deps, [fields[0]])).toEqual({ ok: false, problems: ['after focusing @e3, no element has focus'] })
    vi.mocked(cdpModule.locateFocusedElement).mockResolvedValueOnce({ missed: 'frame_unreachable' })
    expect(await prepareLogin(deps, [fields[0]])).toEqual({ ok: false, problems: ['after focusing @e3, focus is in a frame that could not be reached'] })
  })

  it('refuses hidden, disabled and read-only fields', async () => {
    page['@e1'] = { description: element('text', { rendered: false }) }
    page['@e2'] = { description: element('text', { disabled: true }), box: { ...BOX, y: 40 } }
    page['@e4'] = { description: element('text', { readOnly: true }), box: { ...BOX, y: 80 } }
    const result = await prepareLogin(deps, [
      { ref: '@e1', kind: 'text', label: 'A' },
      { ref: '@e2', kind: 'text', label: 'B' },
      { ref: '@e4', kind: 'text', label: 'C' },
    ])
    expect(result).toEqual({ ok: false, problems: ['@e1 is not visible', '@e2 is disabled', '@e4 is read-only'] })
  })

  it('refuses fields split across frames of different origins', async () => {
    page['@e3'] = { description: element('text') }
    page['@e6'] = { description: element('password', { origin: 'https://login.evil.example' }), box: { ...BOX, y: 60 } }
    const result = await prepareLogin(deps, fields)
    expect(result).toEqual({
      ok: false,
      problems: ['the fields are in frames of different origins (@e3 on https://github.com; @e6 on https://login.evil.example)'],
    })
  })

  it('refuses fields on a page of this app itself, whatever address it was reached at', async () => {
    page['@e3'] = { description: element('text', { origin: 'http://mymac.local:47891', appPage: true }) }
    page['@e6'] = { description: element('password', { origin: 'http://mymac.local:47891', appPage: true }), box: { ...BOX, y: 60 } }
    await expect(prepareLogin(deps, fields)).resolves.toEqual({
      ok: false,
      problems: ['the fields are on a page of this app itself (http://mymac.local:47891), which request_login never fills'],
    })
  })

  it('refuses a frame with no web origin to show the user', async () => {
    page['@e3'] = { description: element('text', { origin: 'null' }) }
    const result = await prepareLogin(deps, [fields[0]])
    expect(result).toEqual({ ok: false, problems: ['the fields\' frame has the origin "null", which is not a web site'] })
  })
})

describe('normalizeCode', () => {
  it('drops spaces always and hyphens in a numeric field', () => {
    expect(normalizeCode(' 123 456 ', { inputType: 'text', inputMode: '' })).toBe('123456')
    expect(normalizeCode('123-456', { inputType: 'text', inputMode: 'numeric' })).toBe('123456')
    expect(normalizeCode('123-456', { inputType: 'tel', inputMode: '' })).toBe('123456')
    expect(normalizeCode('ABCD-EFGH', { inputType: 'text', inputMode: '' })).toBe('ABCD-EFGH')
  })
})

describe('fillLogin', () => {
  const prepared = { origin: 'https://github.com', fields: fields.map((field) => ({ ...field, inputType: 'text', inputMode: '', autocomplete: '', maxLength: -1 })) }

  beforeEach(() => {
    page['@e3'] = { description: element('text') }
    page['@e6'] = { description: element('password'), box: { ...BOX, y: 60 } }
  })

  it('writes each value with the expected origin, kind, allowed types, box, secrecy and fill id', async () => {
    const { outcomes, written } = await fillLogin(deps, cdp, prepared, ['alice', 'pw-1234'], 'fill-1')
    expect(outcomes.map((o) => o.status)).toEqual(['filled', 'filled'])
    expect(writes).toEqual([
      { ref: '@e3', args: ['alice', 'https://github.com', 'username', ['text', 'email', 'tel', 'url'], BOX, false, 'fill-1'] },
      { ref: '@e6', args: ['pw-1234', 'https://github.com', 'password', ['password'], { ...BOX, y: 60 }, true, 'fill-1'] },
    ])
    expect(written.map((w) => [w.index, w.kind])).toEqual([[0, 'username'], [1, 'password']])
  })

  it('normalizes a code before writing it, and hands the value as written to the caller first', async () => {
    page['@e7'] = { description: element('text', { inputMode: 'numeric' }) }
    const code = { origin: 'https://github.com', fields: [{ ref: '@e7', kind: 'otp' as const, label: 'Code', inputType: 'text', inputMode: 'numeric', autocomplete: '', maxLength: 6 }] }
    const before: Array<[string, string, number]> = []
    await fillLogin(deps, cdp, code, ['482-913'], 'fill-1', (field, located, value) => {
      before.push([field.ref, value, writes.length])
      expect(located.objectId).toBe('obj:@e7')
    })
    expect(writes[0].args[0]).toBe('482913')
    expect(before).toEqual([['@e7', '482913', 0]])
  })

  it('skips a field left empty', async () => {
    const { outcomes } = await fillLogin(deps, cdp, prepared, ['alice', ''], 'fill-1')
    expect(outcomes.map((o) => o.status)).toEqual(['filled', 'skipped'])
    expect(writes).toHaveLength(1)
  })

  it('stops at a frame that moved to another origin, writing nothing after it', async () => {
    page['@e3'].description = element('text', { origin: 'https://evil.example' })
    const { outcomes, written } = await fillLogin(deps, cdp, prepared, ['alice', 'pw-1234'], 'fill-1')
    expect(outcomes.map((o) => o.status)).toEqual(['failed', 'failed'])
    expect(outcomes[0].problem).toBe('the frame holding the fields is now on https://evil.example, not https://github.com')
    expect(outcomes[1].problem).toBe(outcomes[0].problem)
    expect(writes).toHaveLength(0)
    expect(written).toHaveLength(0)
  })

  it('stops when the page itself refuses the origin in the write\'s own task', async () => {
    page['@e3'].write = { ok: false, reason: 'origin_changed', origin: 'https://evil.example' }
    const { outcomes } = await fillLogin(deps, cdp, prepared, ['alice', 'pw-1234'], 'fill-1')
    expect(outcomes.map((o) => o.status)).toEqual(['failed', 'failed'])
    expect(writes).toHaveLength(1)
  })

  it('reports a field it can no longer find at fill time, and a write the page threw on', async () => {
    delete page['@e3']
    page['@e6'].write = 'throw'
    const { outcomes, written } = await fillLogin(deps, cdp, prepared, ['alice', 'pw-1234'], 'fill-1')
    expect(outcomes).toMatchObject([
      { ref: '@e3', status: 'failed', problem: '@e3 could not be focused: ✗ Unknown ref: e3' },
      // Sent, and the page may hold it: not a failure that wrote nothing.
      { ref: '@e6', status: 'unconfirmed', problem: 'the write into @e6 was sent and returned no answer (The page function threw)' },
    ])
    expect(written).toEqual([])
  })

  it('names what the page reported for a write it refused', async () => {
    page['@e6'].write = { ok: false, reason: 'not_the_field' }
    const { outcomes } = await fillLogin(deps, cdp, prepared, ['alice', 'pw-1234'], 'fill-1')
    expect(outcomes[1]).toMatchObject({ status: 'failed', problem: '@e6 moved while it was being filled' })
  })

  it('reports a value the page changed and split code boxes, and keeps a rewritten secret for redaction', async () => {
    page['@e3'].write = { ok: true, kept: false }
    page['@e6'].write = { ok: true, kept: false, pageValue: 'PW-1234' }
    const { outcomes, pageValues } = await fillLogin(deps, cdp, prepared, ['alice', 'pw-1234'], 'fill-1')
    expect(outcomes).toMatchObject([{ status: 'changed' }, { status: 'changed' }])
    expect(pageValues).toEqual(['PW-1234'])
    expect(JSON.stringify(outcomes)).not.toContain('PW-1234')
  })
})

describe('after the writes', () => {
  const located = (ref: string, frameId = 'F0'): LocatedElement => ({
    sessionId: undefined, objectId: `obj:${ref}`, frameId, description: element('text') as FocusedElementDescription, topOrigin: 'https://github.com',
  })
  const field = (ref: string, index: number, kept = true, kind: 'password' | 'otp' = 'password', startedAt = 1_000) =>
    ({ index, kind, element: located(ref), value: 'pw', kept, startedAt })
  const refOf = (written: { element: LocatedElement }) => written.element.objectId.slice(4)

  /** A CDP connection that only serves the watch: its frame tree, domain enables and pushed events. */
  function watchedConnection() {
    let listener: ((event: CdpEvent) => void) | null = null
    const sent: Array<[string, string | undefined]> = []
    const connection = {
      pageSession: undefined,
      send: vi.fn(async (method: string, _params: unknown, sessionId?: string) => {
        sent.push([method, sessionId])
        return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'F0' } } } : {}
      }),
      onEvent: (next: (event: CdpEvent) => void) => { listener = next; return () => { listener = null } },
    } as unknown as CdpConnection
    const emit = (method: string, params: object, sessionId?: string) => listener?.({ method, params, sessionId })
    return { connection, sent, emit, listening: () => listener !== null }
  }

  it('reads what became of each written field — also one that read differently right after its write — with the error of one it could not read', async () => {
    page['@e1'] = { description: element('text') }
    page['@e2'] = { description: element('text'), held: 'differs' }
    page['@e3'] = { description: element('text'), held: 'throw' }
    page['@e4'] = { description: element('text'), held: 'held' }
    page['@e5'] = { description: element('text'), held: 'locked' }
    const states = await heldStates(cdp, [field('@e1', 0), field('@e2', 1), field('@e3', 2), field('@e4', 3, false), field('@e5', 4)])
    expect(states).toEqual([
      { index: 0, state: 'held' },
      { index: 1, state: 'differs' },
      { index: 2, state: 'unreadable', error: 'Runtime.callFunctionOn: timed out' },
      { index: 3, state: 'held' },
      { index: 4, state: 'locked' },
    ])
  })

  it('watches the page and each frame session it is told about, enabling their events once', async () => {
    const { connection, sent, listening } = watchedConnection()
    const watch = await PageWatch.start(connection)
    await watch.cover('S-child')
    await watch.cover('S-child')
    expect(watch.mainFrameId).toBe('F0')
    expect(sent).toEqual([
      ['Page.getFrameTree', undefined],
      ['Page.enable', undefined], ['Network.enable', undefined],
      ['Page.enable', 'S-child'], ['Network.enable', 'S-child'],
    ])
    watch.close()
    expect(listening()).toBe(false)
  })

  it('sees a submit event, a field gone from its document, a destroyed context, or an unreadable page', async () => {
    const { connection } = watchedConnection()
    const watch = await PageWatch.start(connection)
    page['@e1'] = { description: element('text'), state: { submitted: true, connected: true, origin: 'https://github.com' } }
    await expect(pageActivityNow(cdp, [field('@e1', 0)], 'fill-1', watch, refOf)).resolves.toEqual({ kind: 'submit' })
    page['@e1'].state = { submitted: false, connected: false, origin: 'https://github.com' }
    await expect(pageActivityNow(cdp, [field('@e1', 0)], 'fill-1', watch, refOf)).resolves.toEqual({ kind: 'detached', ref: '@e1' })
    page['@e1'].state = { error: 'Runtime.callFunctionOn: Cannot find context with specified id' }
    await expect(pageActivityNow(cdp, [field('@e1', 0)], 'fill-1', watch, refOf)).resolves.toEqual({ kind: 'gone' })
    page['@e1'].state = { error: 'Runtime.callFunctionOn: timed out' }
    await expect(pageActivityNow(cdp, [field('@e1', 0)], 'fill-1', watch, refOf)).resolves.toEqual({ kind: 'unreadable', error: 'Runtime.callFunctionOn: timed out' })
    page['@e1'].state = { submitted: false, connected: true, origin: 'https://github.com' }
    await expect(pageActivityNow(cdp, [field('@e1', 0)], 'fill-1', watch, refOf)).resolves.toBeNull()
    await expect(pageActivityNow(cdp, [], 'fill-1', watch, refOf)).resolves.toBeNull()
  })

  it('sees a navigation of the page or the fields\' frame since the first write — not of another frame, nor before', async () => {
    const { connection, emit } = watchedConnection()
    const watch = await PageWatch.start(connection)
    page['@e1'] = { description: element('text') }
    const written = [field('@e1', 0, true, 'password', Date.now())]
    emit('Page.frameRequestedNavigation', { frameId: 'F-ad', url: 'https://ads.example/next' })
    emit('Network.requestWillBeSent', { frameId: 'F0', type: 'Document', request: { method: 'GET', url: 'https://other.example/' } }, 'S-unwatched')
    await expect(pageActivityNow(cdp, written, 'fill-1', watch, refOf)).resolves.toBeNull()
    emit('Network.requestWillBeSent', { frameId: 'F0', type: 'Document', request: { method: 'POST', url: 'https://github.com/session' } })
    await expect(pageActivityNow(cdp, written, 'fill-1', watch, refOf)).resolves.toEqual({ kind: 'navigation', url: 'https://github.com/session' })

    const later = [field('@e1', 0, true, 'password', Date.now() + 60_000)]
    await expect(pageActivityNow(cdp, later, 'fill-1', watch, refOf)).resolves.toBeNull()
  })

  /** A written code field: `value` is what went into the page. */
  const codeField = (startedAt: number) => ({ ...field('@e1', 0, true, 'otp', startedAt), value: '482913' })

  it('after a code, sees the page send that code itself — in a body or a URL — and nothing else', async () => {
    const { connection, emit } = watchedConnection()
    const watch = await PageWatch.start(connection)
    page['@e1'] = { description: element('text') }
    const now = Date.now()
    // A bot-defense beacon and other calls as the boxes change carry no code.
    emit('Network.requestWillBeSent', { frameId: 'F0', type: 'Fetch', request: { method: 'POST', url: 'https://www.booking.com/__challenge_x/telemetry', postData: '{"t":17294829130,"m":[1,2]}' } })
    emit('Network.requestWillBeSent', { frameId: 'F0', type: 'Fetch', request: { method: 'GET', url: 'https://github.com/config' } })
    await expect(pageActivityNow(cdp, [codeField(now)], 'fill-1', watch, refOf)).resolves.toBeNull()

    emit('Network.requestWillBeSent', { frameId: 'F1', type: 'XHR', request: { method: 'POST', url: 'https://github.com/sessions/verify?step=2', postData: 'otp=482913&remember=1' } })
    await expect(pageActivityNow(cdp, [codeField(now)], 'fill-1', watch, refOf)).resolves.toEqual({
      kind: 'request', method: 'POST', url: 'https://github.com/sessions/verify',
    })
    // A password is never looked for in requests: pages post as fields change.
    await expect(pageActivityNow(cdp, [{ ...codeField(now), kind: 'password' as const }], 'fill-1', watch, refOf)).resolves.toBeNull()
  })

  it('finds the code in a URL, or in a body it fetches when the event left the body out', async () => {
    const { connection, emit } = watchedConnection()
    vi.mocked(connection.send).mockImplementation(async (method: string) => (
      method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'F0' } } }
        : method === 'Network.getRequestPostData' ? { postData: '{"code":"482913"}' }
          : {}
    ) as never)
    const watch = await PageWatch.start(connection)
    await watch.cover('S-1')
    page['@e1'] = { description: element('text') }
    emit('Network.requestWillBeSent', { requestId: 'R1', frameId: 'F1', type: 'Fetch', request: { method: 'POST', url: 'https://x.example/v', hasPostData: true } }, 'S-1')
    await expect(pageActivityNow(cdp, [codeField(Date.now() - 1)], 'fill-1', watch, refOf)).resolves.toMatchObject({ kind: 'request', url: 'https://x.example/v' })
    expect(connection.send).toHaveBeenCalledWith('Network.getRequestPostData', { requestId: 'R1' }, 'S-1')

    const { connection: other, emit: emitOther } = watchedConnection()
    const urlWatch = await PageWatch.start(other)
    emitOther('Network.requestWillBeSent', { frameId: 'F0', type: 'Fetch', request: { method: 'GET', url: 'https://x.example/check?code=482913' } })
    await expect(pageActivityNow(cdp, [codeField(Date.now() - 1)], 'fill-1', urlWatch, refOf)).resolves.toEqual({ kind: 'request', method: 'GET', url: 'https://x.example/check' })
  })

  it('keeps watching for the wait, returning as soon as the page moves on', async () => {
    const { connection, emit } = watchedConnection()
    const watch = await PageWatch.start(connection)
    page['@e1'] = { description: element('text') }
    const written = [codeField(Date.now())]
    setTimeout(() => emit('Network.requestWillBeSent', { frameId: 'F0', type: 'XHR', request: { method: 'POST', url: 'https://github.com/verify', postData: '{"otp":"482913"}' } }), 150)
    const started = Date.now()
    await expect(awaitPageActivity(cdp, written, 'fill-1', watch, refOf, 2_000)).resolves.toMatchObject({ kind: 'request' })
    expect(Date.now() - started).toBeLessThan(1_000)
    await expect(awaitPageActivity(cdp, [field('@e1', 0, true, 'password', Date.now())], 'fill-1', watch, refOf, 150)).resolves.toBeNull()
  })

  it('clicks the submit control from the page only when it is located on the expected origin', async () => {
    page['@e9'] = { description: element('button') }
    const written = [field('@e3', 0), field('@e6', 1)]
    await expect(clickSubmitInPage(deps, cdp, '@e9', 'https://github.com', written)).resolves.toBe(true)
    await expect(clickSubmitInPage(deps, cdp, '@e9', 'https://other.example', written)).resolves.toBe(false)
    page['@e9'].clicked = 'origin_changed'
    await expect(clickSubmitInPage(deps, cdp, '@e9', 'https://github.com', written)).resolves.toBe(false)
    await expect(clickSubmitInPage(deps, cdp, '@e99', 'https://github.com', written)).resolves.toBe(false)
  })

  it('binds the click to the last field kept, so a ref resolved again on the next step clicks nothing', async () => {
    page['@e9'] = { description: element('button') }
    await expect(clickSubmitInPage(deps, cdp, '@e9', 'https://github.com', [field('@e3', 0), field('@e6', 1), field('@e7', 2, false)])).resolves.toBe(true)
    expect(inPageClicks).toEqual([{ ref: '@e9', with: '@e6' }])

    // The page's answer when that field is gone, hidden or in another document.
    page['@e9'].clicked = 'moved_on'
    await expect(clickSubmitInPage(deps, cdp, '@e9', 'https://github.com', [field('@e6', 1)])).resolves.toBe(false)
    page['@e9'].clicked = undefined
    // The field in another frame than the button, or no field kept at all.
    await expect(clickSubmitInPage(deps, cdp, '@e9', 'https://github.com', [{ ...field('@e6', 1), element: located('@e6', 'F1') }])).resolves.toBe(false)
    await expect(clickSubmitInPage(deps, cdp, '@e9', 'https://github.com', [field('@e6', 1, false)])).resolves.toBe(false)
    expect(inPageClicks).toHaveLength(2)
  })

  it('says whether Enter would land in the last field written', async () => {
    page['@e1'] = { description: element('text'), focused: true }
    await expect(lastFieldHasFocus(cdp, [field('@e1', 0)], 'https://github.com')).resolves.toBe(true)
    page['@e1'].focused = false
    await expect(lastFieldHasFocus(cdp, [field('@e1', 0)], 'https://github.com')).resolves.toBe(false)
    await expect(lastFieldHasFocus(cdp, [], 'https://github.com')).resolves.toBe(false)
  })
})
