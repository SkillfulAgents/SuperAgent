// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLICK_IN_PAGE_FUNCTION,
  DEEP_ACTIVE_ELEMENT_EXPRESSION,
  DESCRIBE_ELEMENT_FUNCTION,
  FILL_PAGE_STATE_FUNCTION,
  HOLDS_VALUE_FUNCTION,
  LOGIN_FIELD_INPUT_TYPES,
  LOGIN_FIELD_KINDS,
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

type Write = (this: Element, value: string, origin: string, kind: LoginFieldKind, types: readonly string[], box: FieldBox | null, secret: boolean, fillId: string) => WriteFieldResult
const writeField = (0, eval)(`(${WRITE_FIELD_FUNCTION})`) as Write
const describeElement = (0, eval)(`(${DESCRIBE_ELEMENT_FUNCTION})`) as (this: Element) => FocusedElementDescription
const holdsValue = (0, eval)(`(${HOLDS_VALUE_FUNCTION})`) as (this: Element, value: string, kind?: LoginFieldKind, types?: readonly string[]) => HeldState
const pageState = (0, eval)(`(${FILL_PAGE_STATE_FUNCTION})`) as (this: Element, fillId: string) => FillPageState
const clickInPage = (0, eval)(`(${CLICK_IN_PAGE_FUNCTION})`) as (this: Element, origin: string, field: Element) => string
const stillFocused = (0, eval)(`(${STILL_FOCUSED_FUNCTION})`) as (this: Element, origin: string) => boolean

const BOX = { x: 10, y: 20, width: 200, height: 30 }

function write(el: Element, value: string, kind: LoginFieldKind, opts: { origin?: string; box?: FieldBox | null; fillId?: string } = {}) {
  return writeField.call(el, value, opts.origin ?? location.origin, kind, LOGIN_FIELD_INPUT_TYPES[kind], opts.box === undefined ? BOX : opts.box, SECRET_LOGIN_FIELD_KINDS.has(kind), opts.fillId ?? 'fill-1')
}

function input(html: string): HTMLInputElement {
  document.body.innerHTML = html
  return document.body.querySelector('input, textarea') as HTMLInputElement
}

describe('login page functions', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    // The page functions keep their state in the isolated world's globals; here, jsdom's.
    for (const name of ['__superagentLoginWatch', '__superagentLoginWatched', '__superagentTyped']) {
      delete (globalThis as Record<string, unknown>)[name]
    }
    vi.restoreAllMocks()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      ...BOX, top: BOX.y, left: BOX.x, right: BOX.x + BOX.width, bottom: BOX.y + BOX.height, toJSON: () => ({}),
    })
  })

  describe('the kind tables', () => {
    it('lets only secret kinds into a password input, and keeps the identifier the only visible kind', () => {
      for (const kind of LOGIN_FIELD_KINDS) {
        if (LOGIN_FIELD_INPUT_TYPES[kind].includes('password')) expect(SECRET_LOGIN_FIELD_KINDS.has(kind)).toBe(true)
      }
      expect([...SECRET_LOGIN_FIELD_KINDS].sort()).toEqual(['otp', 'password', 'text'])
      expect(LOGIN_FIELD_INPUT_TYPES.password).toEqual(['password'])
      expect(LOGIN_FIELD_INPUT_TYPES.username).not.toContain('password')
      expect(LOGIN_FIELD_INPUT_TYPES.text).not.toContain('password')
    })
  })

  it('writes the value and fires the events frameworks listen for', () => {
    const el = input('<input id="u" type="email">')
    const events: string[] = []
    el.addEventListener('input', (event) => events.push(`input:${(event as InputEvent).inputType}`))
    el.addEventListener('change', () => events.push('change'))
    el.addEventListener('keyup', () => events.push('keyup'))

    expect(write(el, 'alice@example.com', 'username')).toEqual({ ok: true, kept: true })
    expect(el.value).toBe('alice@example.com')
    expect(events).toEqual(['input:insertText', 'change', 'keyup'])
  })

  it('writes through the prototype setter, so an instance-level value tracker (React) sees a change', () => {
    const el = input('<input type="password">')
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
    let tracked = ''
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() { return native.get!.call(this) },
      set(v: string) { tracked = v; native.set!.call(this, v) },
    })
    let changedForReact = false
    el.addEventListener('input', () => { changedForReact = native.get!.call(el) !== tracked })

    write(el, 's3cret-pass', 'password')

    expect(tracked).toBe('')
    expect(changedForReact).toBe(true)
    expect(native.get!.call(el)).toBe('s3cret-pass')
  })

  it('refuses a frame on another origin and writes nothing', () => {
    const el = input('<input type="password">')
    expect(write(el, 'leak-me', 'password', { origin: 'https://evil.example' })).toEqual({
      ok: false, reason: 'origin_changed', origin: location.origin,
    })
    expect(el.value).toBe('')
  })

  it('compares whole origins: a page whose origin only starts like the expected one is refused', () => {
    const el = input('<input type="password">')
    // jsdom serves http://localhost:3000; the expected origin is a prefix of it.
    expect(write(el, 'leak-me', 'password', { origin: location.origin.slice(0, -1) })).toMatchObject({ ok: false, reason: 'origin_changed' })
    expect(write(el, 'leak-me', 'password', { origin: `${location.origin}.evil.example` })).toMatchObject({ ok: false, reason: 'origin_changed' })
    expect(el.value).toBe('')
  })

  it('never writes a password into a non-password field, or a username or text into a password field', () => {
    expect(write(input('<input type="email">'), 'pw', 'password')).toEqual({ ok: false, reason: 'wrong_type', type: 'email' })
    expect(write(input('<input type="password">'), 'me', 'username')).toEqual({ ok: false, reason: 'wrong_type', type: 'password' })
    expect(write(input('<input type="password">'), 'me', 'text')).toEqual({ ok: false, reason: 'wrong_type', type: 'password' })
    expect(write(input('<input type="checkbox">'), 'x', 'text')).toEqual({ ok: false, reason: 'wrong_type', type: 'checkbox' })
  })

  it('takes text in a textarea and a code in a numeric field', () => {
    expect(write(input('<textarea></textarea>'), 'Acme Inc', 'text')).toEqual({ ok: true, kept: true })
    expect(write(input('<input type="number">'), '482913', 'otp')).toEqual({ ok: true, kept: true })
  })

  it('refuses disabled (also by a fieldset), read-only, hidden and detached fields', () => {
    expect(write(input('<input type="text" disabled>'), 'x', 'username')).toEqual({ ok: false, reason: 'not_editable' })
    expect(write(input('<fieldset disabled><input type="text"></fieldset>'), 'x', 'username')).toEqual({ ok: false, reason: 'not_editable' })
    expect(write(input('<input type="text" readonly>'), 'x', 'username')).toEqual({ ok: false, reason: 'not_editable' })
    expect(write(input('<input type="text" style="display:none">'), 'x', 'username')).toEqual({ ok: false, reason: 'not_visible' })
    const detached = document.createElement('input')
    expect(write(detached, 'x', 'username')).toEqual({ ok: false, reason: 'detached' })
  })

  it('refuses an element that is not where the ref\'s element was, beyond two pixels', () => {
    const el = input('<input type="text">')
    expect(write(el, 'x', 'username', { box: { ...BOX, y: BOX.y + 40 } })).toEqual({ ok: false, reason: 'not_the_field' })
    expect(write(el, 'x', 'username', { box: { ...BOX, x: BOX.x + 3 } })).toEqual({ ok: false, reason: 'not_the_field' })
    expect(write(el, 'x', 'username', { box: { ...BOX, width: BOX.width - 3 } })).toEqual({ ok: false, reason: 'not_the_field' })
    expect(el.value).toBe('')
    expect(write(el, 'x', 'username', { box: { ...BOX, x: BOX.x + 1.5 } })).toEqual({ ok: true, kept: true })
  })

  it('reports a value the page changed, and hands back a rewritten secret for redaction only', () => {
    const name = input('<input type="text">')
    name.addEventListener('input', () => { name.value = name.value.toUpperCase() })
    expect(write(name, 'alice', 'username')).toEqual({ ok: true, kept: false })

    const code = input('<input type="text">')
    code.addEventListener('input', () => { code.value = code.value.replace(/(\d{3})(\d{3})/, '$1 $2') })
    expect(write(code, '482913', 'otp')).toEqual({ ok: true, kept: false, pageValue: '482 913' })
  })

  it('types a code across split one-character boxes, moving focus box by box', () => {
    document.body.innerHTML = `<form><div id="g">${'<input maxlength="1" inputmode="numeric">'.repeat(6)}</div></form>`
    const boxes = Array.from(document.querySelectorAll('input'))
    const focused: number[] = []
    boxes.forEach((box, i) => box.addEventListener('focus', () => focused.push(i)))

    expect(write(boxes[0], '135792', 'otp')).toEqual({ ok: true, kept: true, boxes: 6 })
    expect(boxes.map((b) => b.value).join('')).toBe('135792')
    expect(focused).toEqual([0, 1, 2, 3, 4, 5])
    expect(holdsValue.call(boxes[0], '135792')).toBe('held')
  })

  it('reads a split code back from the same boxes it typed, past a disabled box between them', () => {
    document.body.innerHTML = `<div>${'<input maxlength="1">'.repeat(3)}<input maxlength="1" disabled>${'<input maxlength="1">'.repeat(3)}</div>`
    const boxes = Array.from(document.querySelectorAll('input'))
    expect(write(boxes[0], '135792', 'otp')).toEqual({ ok: true, kept: true, boxes: 6 })
    expect(boxes[3].value).toBe('')
    expect(holdsValue.call(boxes[0], '135792')).toBe('held')
    boxes[5].value = ''
    expect(holdsValue.call(boxes[0], '135792')).toBe('differs')
  })

  /** Six code boxes whose first takes a pasted code and hands one character to each box (Yahoo, Booking). */
  function spreadingBoxes(firstMaxLength: string, later = false) {
    document.body.innerHTML = `<div>${`<input${firstMaxLength} inputmode="numeric">`}${'<input inputmode="numeric">'.repeat(5)}</div>`
    const boxes = Array.from(document.querySelectorAll('input'))
    boxes[0].addEventListener('input', () => {
      const pasted = boxes[0].value
      if (pasted.length < 2) return
      const spread = () => pasted.split('').forEach((char, i) => { if (boxes[i]) boxes[i].value = char })
      if (!later) return spread()
      // The box keeps one character at once; the rest arrive with the next render.
      boxes[0].value = pasted[0]
      setTimeout(spread, 5)
    })
    return boxes
  }

  it('finds a code the page spread over the boxes after the one it went into, and masks them all', () => {
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty')
    for (const firstMaxLength of [' maxlength="6"', '']) {
      setProperty.mockClear()
      const boxes = spreadingBoxes(firstMaxLength)
      expect(write(boxes[0], '482913', 'otp')).toEqual({ ok: true, kept: true, boxes: 6 })
      expect(boxes.map((box) => box.value).join('')).toBe('482913')
      expect(holdsValue.call(boxes[0], '482913', 'otp', LOGIN_FIELD_INPUT_TYPES.otp)).toBe('held')
      expect(setProperty.mock.calls.filter(([name]) => name === '-webkit-text-security')).toHaveLength(6)
    }
  })

  it('finds a code the page spread over the boxes a moment after the write, at the read-back', async () => {
    const boxes = spreadingBoxes(' maxlength="6"', true)
    expect(write(boxes[0], '482913', 'otp')).toMatchObject({ ok: true, kept: false })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(holdsValue.call(boxes[0], '482913', 'otp', LOGIN_FIELD_INPUT_TYPES.otp)).toBe('held')
    // From then on the field is those boxes: one of them emptied reads as another value.
    boxes[4].value = ''
    expect(holdsValue.call(boxes[0], '482913', 'otp', LOGIN_FIELD_INPUT_TYPES.otp)).toBe('differs')
  })

  it('reads a code that stayed in one box only as that box, not as boxes that happen to follow it', () => {
    document.body.innerHTML = `<div><input id="c" inputmode="numeric">${'<input>'.repeat(6)}</div>`
    const el = document.getElementById('c') as HTMLInputElement
    expect(write(el, '482913', 'otp')).toEqual({ ok: true, kept: true })
    el.value = '4'
    expect(holdsValue.call(el, '482913', 'otp', LOGIN_FIELD_INPUT_TYPES.otp)).toBe('differs')
  })

  it('reads boxes the page locked while it verifies as locked, not as another value', () => {
    document.body.innerHTML = `<div>${'<input maxlength="1">'.repeat(6)}</div>`
    const boxes = Array.from(document.querySelectorAll('input'))
    write(boxes[0], '135792', 'otp')
    for (const box of boxes) box.disabled = true
    expect(holdsValue.call(boxes[0], '135792')).toBe('locked')
  })

  it('lets Enter land in any of the boxes a split code was typed across', () => {
    document.body.innerHTML = `<div>${'<input maxlength="1">'.repeat(6)}</div><input id="other">`
    const boxes = Array.from(document.querySelectorAll('div input')) as HTMLInputElement[]
    write(boxes[0], '135792', 'otp')
    expect(document.activeElement).toBe(boxes[5])
    expect(stillFocused.call(boxes[0], location.origin)).toBe(true)
    ;(document.getElementById('other') as HTMLInputElement).focus()
    expect(stillFocused.call(boxes[0], location.origin)).toBe(false)
  })

  it('masks a code or other secret written into a visible text input, so a screenshot does not show it', () => {
    // jsdom drops properties it does not know, so watch the call itself.
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty')
    const masks = () => setProperty.mock.calls.filter(([name]) => name === '-webkit-text-security')
    write(input('<input type="text">'), '482913', 'otp')
    write(input('<input type="text">'), 'Acme Secret', 'text')
    expect(masks()).toEqual([
      ['-webkit-text-security', 'disc', 'important'],
      ['-webkit-text-security', 'disc', 'important'],
    ])
    setProperty.mockClear()
    write(input('<input type="email">'), 'alice@example.com', 'username')
    write(input('<input type="password">'), 'pw-123456', 'password')
    expect(masks()).toEqual([])
  })

  it('refuses a code longer than the boxes that follow the mapped one', () => {
    document.body.innerHTML = `<div>${'<input maxlength="1">'.repeat(4)}</div>`
    const boxes = Array.from(document.querySelectorAll('input'))
    expect(write(boxes[1], '1234', 'otp')).toEqual({ ok: false, reason: 'otp_boxes' })
    expect(boxes.every((b) => b.value === '')).toBe(true)
  })

  it('reads whether a field still holds its value, holds another, was locked, or left its document', () => {
    const el = input('<input type="password">')
    write(el, 'pw-123456', 'password')
    expect(holdsValue.call(el, 'pw-123456')).toBe('held')
    el.readOnly = true
    expect(holdsValue.call(el, 'pw-123456')).toBe('locked')
    el.value = ''
    expect(holdsValue.call(el, 'pw-123456')).toBe('differs')
    el.remove()
    expect(holdsValue.call(el, 'pw-123456')).toBe('detached')
  })

  it('records a form the page submitted after the write, for this fill only', () => {
    document.body.innerHTML = '<form><input id="c" type="text"></form>'
    const form = document.querySelector('form')!
    form.addEventListener('submit', (event) => event.preventDefault())
    const el = document.getElementById('c') as HTMLInputElement
    el.addEventListener('input', () => { if (el.value.length === 6) form.requestSubmit() })

    write(el, '482913', 'otp', { fillId: 'fill-a' })
    expect(pageState.call(el, 'fill-a')).toEqual({ submitted: true, connected: true, origin: location.origin })
    expect(pageState.call(el, 'fill-b')).toMatchObject({ submitted: false })
    write(el, '111', 'otp', { fillId: 'fill-b' })
    expect(pageState.call(el, 'fill-b')).toMatchObject({ submitted: false, connected: true })
  })

  it('sees a form in a shadow root submit itself, though its submit event never reaches the document', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<form><input type="text"></form>'
    const form = root.querySelector('form')!
    form.addEventListener('submit', (event) => event.preventDefault())
    const documentSaw = vi.fn()
    document.addEventListener('submit', documentSaw, true)
    const el = root.querySelector('input')!
    el.addEventListener('input', () => form.requestSubmit())

    write(el, '482913', 'otp', { fillId: 'fill-s' })
    expect(documentSaw).not.toHaveBeenCalled()
    expect(pageState.call(el, 'fill-s')).toMatchObject({ submitted: true })
    document.removeEventListener('submit', documentSaw, true)
  })

  it('clicks the submit control from the page only on the expected origin', () => {
    document.body.innerHTML = '<input id="f"><button id="b">Sign in</button>'
    const button = document.getElementById('b')!
    const field = document.getElementById('f')!
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    expect(clickInPage.call(button, 'https://evil.example', field)).toBe('origin_changed')
    expect(clicked).not.toHaveBeenCalled()
    expect(clickInPage.call(button, location.origin, field)).toBe('clicked')
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('clicks nothing once the field just filled is gone, hidden or in another document', () => {
    document.body.innerHTML = '<input id="f"><button id="b">Continue</button>'
    const button = document.getElementById('b')!
    const field = document.getElementById('f')!
    const clicked = vi.fn()
    button.addEventListener('click', clicked)

    const elsewhere = document.implementation.createHTMLDocument('next step')
    elsewhere.body.innerHTML = '<input>'
    expect(clickInPage.call(button, location.origin, elsewhere.querySelector('input')!)).toBe('moved_on')
    expect(clickInPage.call(button, location.origin, null as unknown as Element)).toBe('moved_on')
    Object.assign(field, { checkVisibility: () => false })
    expect(clickInPage.call(button, location.origin, field)).toBe('moved_on')
    field.remove()
    expect(clickInPage.call(button, location.origin, field)).toBe('moved_on')
    expect(clicked).not.toHaveBeenCalled()
  })

  it('says whether Enter would land in the field, on the expected origin', () => {
    document.body.innerHTML = '<input id="a"><input id="b">'
    const a = document.getElementById('a') as HTMLInputElement
    a.focus()
    expect(stillFocused.call(a, location.origin)).toBe(true)
    expect(stillFocused.call(a, 'https://evil.example')).toBe(false)
    ;(document.getElementById('b') as HTMLInputElement).focus()
    expect(stillFocused.call(a, location.origin)).toBe(false)
  })

  it('finds the focused element through open shadow roots', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<input id="inner" type="text">'
    const inner = root.querySelector('input')!
    inner.focus()
    const found = (0, eval)(DEEP_ACTIVE_ELEMENT_EXPRESSION)
    expect(found).toBe(inner)
  })

  it('finds nothing when focus is on the page body', () => {
    document.body.innerHTML = '<input>'
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    expect((0, eval)(DEEP_ACTIVE_ELEMENT_EXPRESSION)).toBeNull()
  })

  it('describes a field without its value, with attribute hints capped', () => {
    const el = input(`<input type="email" autocomplete="username ${'x'.repeat(300)}" inputmode="email" maxlength="64" value="secret@example.com">`)
    const description = describeElement.call(el)
    expect(description).toMatchObject({
      tag: 'input', type: 'email', isFrame: false, origin: location.origin, rendered: true,
      disabled: false, readOnly: false, inputMode: 'email', maxLength: 64, box: BOX,
    })
    expect(description.autocomplete.length).toBeLessThanOrEqual(100)
    expect(JSON.stringify(description)).not.toContain('secret@example.com')
    expect(description.appPage).toBe(false)
  })

  it('tells a page of the app itself by the marker the app\'s pages carry', () => {
    const marker = document.createElement('meta')
    marker.name = 'superagent-app'
    document.head.appendChild(marker)
    try {
      expect(describeElement.call(input('<input type="password">')).appPage).toBe(true)
    } finally {
      marker.remove()
    }
  })
})
