import { describe, it, expect } from 'vitest'
import {
  observerScript,
  parseObservation,
  EMPTY_OBSERVATION,
  PREVIEW_CHARS,
  THIN_TREE_PREVIEW_CHARS,
  type PageObservation,
} from './page-observer'

// ---------------------------------------------------------------------------
// A small fake DOM: enough for every querySelector/innerText call the
// observer script makes. Each test builds a page, runs the script against it
// and reads the JSON back.
// ---------------------------------------------------------------------------

type FakeEl = {
  tag?: string; role?: string | null; text?: string; visible?: boolean; label?: string | null
  labelledby?: string | null; heading?: string | null; matchesPopover?: boolean
  placeholder?: string | null; name?: string | null; labels?: Array<{ innerText: string }>
  checkVisibility?: boolean; type?: string; value?: string; isContentEditable?: boolean; checked?: boolean
  src?: string; title?: string; sameOrigin?: boolean
  attrs?: Record<string, string>
}
function el(o: FakeEl) {
  const attrs: Record<string, string | null> = {
    role: o.role ?? null, 'aria-label': o.label ?? null, 'aria-labelledby': o.labelledby ?? null,
    placeholder: o.placeholder ?? null, name: o.name ?? null, ...(o.attrs ?? {}),
  }
  return {
    nodeType: 1,
    tagName: (o.tag ?? 'div').toUpperCase(),
    type: o.type,
    value: o.value,
    ...(o.checked !== undefined ? { checked: o.checked } : {}),
    isContentEditable: o.isContentEditable ?? false,
    innerText: o.text ?? '',
    title: o.title ?? '',
    src: o.src ?? '',
    labels: o.labels,
    offsetParent: o.visible === false ? null : {},
    ...(o.checkVisibility !== undefined ? { checkVisibility: () => o.checkVisibility } : {}),
    getClientRects: () => (o.visible === false ? [] : [{}]),
    getAttribute: (k: string) => attrs[k] ?? null,
    querySelector: (q: string) => (q.startsWith('h1') && o.heading ? { innerText: o.heading } : null),
    matches: (q: string) => q === ':popover-open' && Boolean(o.matchesPopover),
    get contentDocument() {
      if (o.sameOrigin) return {}
      throw new Error('cross-origin')
    },
  }
}

type Page = {
  sel?: Record<string, unknown[]>; body?: string; main?: unknown; active?: unknown
  title?: string; readyState?: string; contentType?: string; href?: string; status?: number
  errorPage?: boolean
}

const LIVE = '[role="alert"],[role="status"],[aria-live]:not([aria-live="off"]),output'
const INTERACTIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[role="combobox"],[role="textbox"],[role="switch"],[role="slider"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
const TOP = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]'

function makePage(page: Page) {
  const body = { innerText: page.body ?? '' }
  const document = {
    body,
    title: page.title ?? '',
    readyState: page.readyState ?? 'complete',
    contentType: page.contentType ?? 'text/html',
    activeElement: page.active ?? body,
    getElementById: (id: string) => (id === 'main-frame-error' && page.errorPage ? {} : null),
    querySelector: (q: string) => (q === 'main,[role=main]' ? page.main ?? null : null),
    querySelectorAll: (q: string) => page.sel?.[q] ?? [],
  }
  const performance = {
    getEntriesByType: (t: string) => (t === 'navigation' ? [{ responseStatus: page.status ?? 200 }] : []),
  }
  const location = { href: page.href ?? 'https://app.com/x', host: 'app.com' }
  const run = (opts: Parameters<typeof observerScript>[0] = {}) => {
    const fn = new Function('document', 'performance', 'location', 'URL', `return ${observerScript(opts)}`)
    return JSON.parse(fn(document, performance, location, URL)) as Record<string, unknown>
  }
  return { run, page }
}

describe('observerScript', () => {
  it('reads url, title, readyState, HTTP status and content type', () => {
    const { run } = makePage({ title: ' Acme  Shop ', readyState: 'interactive', status: 404, href: 'https://acme.com/a?b=1' })
    expect(run()).toMatchObject({ url: 'https://acme.com/a?b=1', title: 'Acme Shop', readyState: 'interactive', httpStatus: 404, contentType: 'text/html', blocker: '', netError: '' })
  })

  it('measures the page text, hashes the content region, previews main, and takes a longer preview on request', () => {
    const { run } = makePage({ body: 'Hello\n\n  world  ', main: { innerText: 'Main   content ' + 'x'.repeat(2000) } })
    const a = run()
    expect(a.textChars).toBe('Hello world'.length)
    expect(a.contentChars).toBe('Main content '.length + 2000)
    expect(typeof a.contentHash).toBe('number')
    expect(String(a.preview).startsWith('Main content x')).toBe(true)
    expect(String(a.preview).length).toBe(PREVIEW_CHARS)
    expect(String(run({ previewChars: THIN_TREE_PREVIEW_CHARS }).preview).length).toBe(THIN_TREE_PREVIEW_CHARS)
    // Without a main region the content is the body.
    const b = makePage({ body: 'Just body' }).run()
    expect(b.contentChars).toBe(9)
    expect(b.preview).toBe('Just body')
  })

  it('reads visible live regions once each, skipping hidden and empty ones', () => {
    const { run } = makePage({ sel: { [LIVE]: [el({ text: '  Email is   required ' }), el({ text: 'Email is required' }), el({ text: 'hidden toast', visible: false }), el({ text: '' })] } })
    expect(run().liveRegions).toEqual(['Email is required'])
  })

  it('counts visible interactive elements, honouring checkVisibility when present', () => {
    const { run } = makePage({ sel: { [INTERACTIVE]: [el({ tag: 'a' }), el({ tag: 'a', visible: false }), el({ tag: 'a', checkVisibility: false }), el({ tag: 'button', checkVisibility: true })] } })
    expect(run().interactive).toBe(2)
  })

  it('hashes the state of visible controls, so a toggle is an observed change', () => {
    const box = el({ tag: 'input', type: 'checkbox', checked: false })
    const like = el({ tag: 'button', attrs: { 'aria-pressed': 'false' } })
    const hidden = el({ tag: 'input', type: 'checkbox', checked: false, visible: false })
    const p = makePage({ sel: { [INTERACTIVE]: [box, like, hidden] } })
    const a = p.run()
    ;(box as { checked: boolean }).checked = true
    const b = p.run()
    expect(b.stateHash).not.toBe(a.stateHash)
    like.getAttribute = (k: string) => (k === 'aria-pressed' ? 'true' : null)
    const c = p.run()
    expect(c.stateHash).not.toBe(b.stateHash)
    // A hidden control's state is not part of what the agent can see.
    ;(hidden as { checked: boolean }).checked = true
    expect(p.run().stateHash).toBe(c.stateHash)
  })

  it('names open dialogs and dedupes them', () => {
    const { run } = makePage({ sel: { [TOP]: [el({ tag: 'dialog', heading: 'Delete project?' }), el({ role: 'alertdialog', label: 'Confirm' }), el({ tag: 'dialog', heading: 'Delete project?' }), el({ tag: 'dialog', visible: false })] } })
    expect(run().top).toEqual([{ kind: 'dialog', name: 'Delete project?' }, { kind: 'alertdialog', name: 'Confirm' }])
  })

  it('describes focus by role (explicit or implied) with its name and value', () => {
    expect(makePage({ active: el({ tag: 'input', labels: [{ innerText: 'Search' }], value: '  clay run gtm ' }) }).run()).toMatchObject({ focus: 'textbox "Search"', focusValue: 'clay run gtm' })
    expect(makePage({ active: el({ tag: 'a', text: 'Wikipedia' }) }).run().focus).toBe('link "Wikipedia"')
    expect(makePage({ active: el({ tag: 'div', role: 'textbox', label: 'Message', text: 'Hi', isContentEditable: true }) }).run()).toMatchObject({ focus: 'textbox "Message"', focusValue: 'Hi' })
    expect(makePage({}).run().focus).toBe('nothing focused')
  })

  it('never reports the value of a password or other secret field', () => {
    expect(makePage({ active: el({ tag: 'input', type: 'password', labels: [{ innerText: 'Password' }], value: 'hunter2' }) }).run()).toMatchObject({ focus: 'textbox "Password"', focusValue: '' })
    expect(makePage({ active: el({ tag: 'input', attrs: { autocomplete: 'cc-number' }, value: '4242424242424242' }) }).run().focusValue).toBe('')
    expect(makePage({ active: el({ tag: 'input', attrs: { autocomplete: 'one-time-code' }, value: '123456' }) }).run().focusValue).toBe('')
    expect(makePage({ active: el({ tag: 'input', attrs: { autocomplete: 'email' }, value: 'a@b.c' }) }).run().focusValue).toBe('a@b.c')
  })

  it('lists visible iframes with host and origin', () => {
    const { run } = makePage({ sel: { iframe: [el({ src: 'https://js.stripe.com/v3/elements', title: 'Secure payment' }), el({ src: 'https://app.com/inner', sameOrigin: true }), el({ src: 'https://x.com', visible: false })] } })
    expect(run().iframes).toEqual([{ title: 'Secure payment', host: 'js.stripe.com', sameOrigin: false }, { title: '', host: 'app.com', sameOrigin: true }])
  })

  it('recognises challenge walls only by their own wording on a page with nothing to interact with, and Chrome error pages', () => {
    expect(makePage({ body: 'Checking your browser before accessing example.com', title: 'Just a moment...' }).run().blocker).toBe('Cloudflare')
    expect(makePage({ body: 'To continue, type the characters', href: 'https://www.google.com/sorry/index?x' }).run().blocker).toBe('Google')
    const form = [el({ tag: 'input' }), el({ tag: 'input', type: 'password' }), el({ tag: 'button' }), el({ tag: 'a' }), el({ tag: 'a' })]
    // The reCAPTCHA disclosure on an ordinary login form, a help article about CAPTCHAs, a status page with incident ids.
    expect(makePage({ body: 'Sign in. This site is protected by reCAPTCHA and the Google Privacy Policy apply.', sel: { [INTERACTIVE]: form } }).run().blocker).toBe('')
    expect(makePage({ body: 'How hCaptcha and Cloudflare Turnstile verify you are human', sel: { [INTERACTIVE]: form } }).run().blocker).toBe('')
    expect(makePage({ body: 'Incident ID 4711 resolved', sel: { [INTERACTIVE]: form } }).run().blocker).toBe('')
    // The same wording on a wall (nothing to interact with) or with a challenge status is a block.
    expect(makePage({ body: 'Verify you are human by completing the action below.', sel: { [INTERACTIVE]: [el({ tag: 'button' })] } }).run().blocker).toBe('Cloudflare')
    expect(makePage({ body: 'Verify you are human by completing the action below.', status: 403, sel: { [INTERACTIVE]: form } }).run().blocker).toBe('Cloudflare')
    expect(makePage({ body: "This site can't be reached ERR_NAME_NOT_RESOLVED", errorPage: true }).run().netError).toBe('ERR_NAME_NOT_RESOLVED')
    expect(makePage({ href: 'chrome-error://chromewebdata/' }).run().netError).toBe('net error')
  })

  it('survives a page whose DOM throws at every turn', () => {
    const hostile = {
      body: null,
      get title() { throw new Error('no') },
      readyState: 'complete',
      contentType: 'text/html',
      activeElement: null,
      getElementById: () => { throw new Error('no') },
      querySelector: () => { throw new Error('no') },
      querySelectorAll: () => { throw new Error('no') },
    }
    const fn = new Function('document', 'performance', 'location', 'URL', `return ${observerScript()}`)
    const out = parseObservation(fn(hostile, { getEntriesByType: () => { throw new Error('no') } }, { href: 'https://h.com/', host: 'h.com' }, URL))
    expect(out).toMatchObject({ url: 'https://h.com/', readyState: '', interactive: 0, focus: 'nothing focused', top: [], liveRegions: [] })
  })
})

describe('parseObservation', () => {
  it('parses double-encoded observer output with defaults for missing parts', () => {
    const raw = JSON.stringify(JSON.stringify({ url: 'https://a.com', httpStatus: 200, top: [{ name: 'Cart' }] }))
    expect(parseObservation(raw)).toEqual({ ...EMPTY_OBSERVATION, url: 'https://a.com', httpStatus: 200, top: [{ kind: 'dialog', name: 'Cart' }] })
  })

  it('accepts a forwarded observation unchanged and rejects garbage', () => {
    const obs: PageObservation = { ...EMPTY_OBSERVATION, url: 'https://a.com', liveRegions: ['Saved'], interactive: 2 }
    expect(parseObservation(JSON.stringify(obs))).toEqual(obs)
    expect(parseObservation('✗ Error: Execution context was destroyed')).toBeNull()
    expect(parseObservation('[1,2]')).toBeNull()
    expect(parseObservation('{"url":5}')).toBeNull()
  })
})
