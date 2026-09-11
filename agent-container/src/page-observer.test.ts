import { describe, it, expect } from 'vitest'
import {
  observerScript,
  parseObservation,
  describeBusy,
  transientBusy,
  EMPTY_OBSERVATION,
  PREVIEW_CHARS,
  THIN_TREE_PREVIEW_CHARS,
  type PageObservation,
} from './page-observer'

// ---------------------------------------------------------------------------
// A small fake DOM: enough for every querySelector/innerText/animation/
// network call the observer script makes. Each test builds a page, runs the
// script against it (optionally several times, to exercise the install-once
// instrumentation and the baselines), and reads the JSON back.
// ---------------------------------------------------------------------------

type FakeEl = {
  tag?: string; role?: string | null; text?: string; visible?: boolean; label?: string | null
  labelledby?: string | null; heading?: string | null; matchesPopover?: boolean
  placeholder?: string | null; name?: string | null; labels?: Array<{ innerText: string }>
  checkVisibility?: boolean; type?: string; value?: string; isContentEditable?: boolean
  src?: string; title?: string; sameOrigin?: boolean
  rect?: { width: number; height: number; top: number }
  attrs?: Record<string, string>
}
function el(o: FakeEl) {
  const attrs: Record<string, string | null> = {
    role: o.role ?? null, 'aria-label': o.label ?? null, 'aria-labelledby': o.labelledby ?? null,
    placeholder: o.placeholder ?? null, name: o.name ?? null, ...(o.attrs ?? {}),
  }
  const rect = o.rect ?? { width: 100, height: 20, top: 100 }
  return {
    nodeType: 1,
    tagName: (o.tag ?? 'div').toUpperCase(),
    type: o.type,
    value: o.value,
    isContentEditable: o.isContentEditable ?? false,
    innerText: o.text ?? '',
    title: o.title ?? '',
    src: o.src ?? '',
    labels: o.labels,
    offsetParent: o.visible === false ? null : {},
    ...(o.checkVisibility !== undefined ? { checkVisibility: () => o.checkVisibility } : {}),
    getClientRects: () => (o.visible === false ? [] : [{}]),
    getBoundingClientRect: () => ({ ...rect, left: 0, right: rect.width, bottom: rect.top + rect.height }),
    getAttribute: (k: string) => attrs[k] ?? null,
    querySelector: (q: string) => (q.startsWith('h1') && o.heading ? { innerText: o.heading } : null),
    closest: (q: string) => (q.includes('progressbar') && o.role === 'progressbar' ? {} : null),
    matches: (q: string) => q === ':popover-open' && Boolean(o.matchesPopover),
    get contentDocument() {
      if (o.sameOrigin) return {}
      throw new Error('cross-origin')
    },
  }
}

type FakeAnimation = { target: unknown; currentTime: number | null; running?: boolean; infinite?: boolean }
type Page = {
  sel?: Record<string, unknown[]>; body?: string; main?: unknown; active?: unknown
  title?: string; readyState?: string; contentType?: string; href?: string; status?: number
  errorPage?: boolean; cursor?: string; animations?: FakeAnimation[]
  resources?: Array<{ name: string; startTime: number; responseStatus: number; initiatorType?: string }>
  /** Navigation timing loadEventEnd (ms); animations that started before it + 500ms are page decoration. */
  loadEventEnd?: number
}

const LIVE = '[role="alert"],[role="status"],[aria-live]:not([aria-live="off"]),output'
const INTERACTIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[role="combobox"],[role="textbox"],[role="switch"],[role="slider"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
const TOP = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]'
const PROGRESS = '[role="progressbar"]:not([aria-valuenow]),progress:not([value])'
const ARIA_BUSY = '[aria-busy="true"]'

/** A page harness whose window persists across runs (so instrumentation and baselines carry over). */
function makePage(page: Page) {
  let clock = 1000
  const body = { innerText: page.body ?? '' }
  const fetchCalls: Array<{ resolve: (r: { status: number }) => void; reject: (e: Error) => void }> = []
  const window: Record<string, unknown> = {
    innerWidth: 1280,
    fetch: () => new Promise<{ status: number }>((resolve, reject) => { fetchCalls.push({ resolve, reject }) }),
  }
  function XMLHttpRequest(this: Record<string, unknown>) { /* fake */ }
  XMLHttpRequest.prototype.open = function () { /* fake */ }
  XMLHttpRequest.prototype.send = function () { /* fake */ }
  const document = {
    body,
    title: page.title ?? '',
    readyState: page.readyState ?? 'complete',
    contentType: page.contentType ?? 'text/html',
    activeElement: page.active ?? body,
    getElementById: (id: string) => (id === 'main-frame-error' && page.errorPage ? {} : null),
    querySelector: (q: string) => (q === 'main,[role=main]' ? page.main ?? null : null),
    querySelectorAll: (q: string) => page.sel?.[q] ?? [],
    getAnimations: () => (page.animations ?? []).map(a => ({
      playState: a.running === false ? 'paused' : 'running',
      currentTime: a.currentTime,
      effect: { target: a.target, getTiming: () => ({ iterations: a.infinite === false ? 1 : Infinity }) },
    })),
  }
  const performance = {
    now: () => clock,
    getEntriesByType: (t: string) => (t === 'navigation' ? [{ responseStatus: page.status ?? 200, loadEventEnd: page.loadEventEnd ?? 0 }] : page.resources ?? []),
    setResourceTimingBufferSize: () => undefined,
  }
  const location = { href: page.href ?? 'https://app.com/x', host: 'app.com' }
  const getComputedStyle = () => ({ cursor: page.cursor ?? 'auto' })
  const run = (opts: Parameters<typeof observerScript>[0] = {}) => {
    const fn = new Function('window', 'document', 'performance', 'location', 'getComputedStyle', 'URL', 'XMLHttpRequest', `return ${observerScript(opts)}`)
    return JSON.parse(fn(window, document, performance, location, getComputedStyle, URL, XMLHttpRequest)) as Record<string, unknown>
  }
  return {
    run,
    tick: (ms: number) => { clock += ms },
    now: () => clock,
    fetch: (input: string) => (window.fetch as (i: string) => Promise<unknown>)(input),
    resolveFetch: (i: number, status: number) => fetchCalls[i].resolve({ status }),
    page,
  }
}

describe('observerScript — identity, text, live regions, census, dialogs, focus', () => {
  it('reads url, title, readyState, HTTP status and content type', () => {
    const { run } = makePage({ title: ' Acme  Shop ', readyState: 'interactive', status: 404, href: 'https://acme.com/a?b=1' })
    expect(run()).toMatchObject({ url: 'https://acme.com/a?b=1', title: 'Acme Shop', readyState: 'interactive', httpStatus: 404, contentType: 'text/html', blocker: '', netError: '' })
  })

  it('measures and hashes the text, previews main, and takes a longer preview on request', () => {
    const { run } = makePage({ body: 'Hello\n\n  world  ', main: { innerText: 'Main   content ' + 'x'.repeat(2000) } })
    const a = run()
    expect(a.textChars).toBe('Hello world'.length)
    expect(typeof a.textHash).toBe('number')
    expect(String(a.preview).startsWith('Main content x')).toBe(true)
    expect(String(a.preview).length).toBe(PREVIEW_CHARS)
    expect(String(run({ previewChars: THIN_TREE_PREVIEW_CHARS }).preview).length).toBe(THIN_TREE_PREVIEW_CHARS)
  })

  it('reads visible live regions once each, skipping hidden and empty ones', () => {
    const { run } = makePage({ sel: { [LIVE]: [el({ text: '  Email is   required ' }), el({ text: 'Email is required' }), el({ text: 'hidden toast', visible: false }), el({ text: '' })] } })
    expect(run().liveRegions).toEqual(['Email is required'])
  })

  it('counts visible interactive elements, honouring checkVisibility when present', () => {
    const { run } = makePage({ sel: { [INTERACTIVE]: [el({ tag: 'a' }), el({ tag: 'a', visible: false }), el({ tag: 'a', checkVisibility: false }), el({ tag: 'button', checkVisibility: true })] } })
    expect(run().interactive).toBe(2)
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

  it('lists visible iframes with host and origin', () => {
    const { run } = makePage({ sel: { iframe: [el({ src: 'https://js.stripe.com/v3/elements', title: 'Secure payment' }), el({ src: 'https://app.com/inner', sameOrigin: true }), el({ src: 'https://x.com', visible: false })] } })
    expect(run().iframes).toEqual([{ title: 'Secure payment', host: 'js.stripe.com', sameOrigin: false }, { title: '', host: 'app.com', sameOrigin: true }])
  })

  it('recognises bot walls and Chrome error pages', () => {
    expect(makePage({ body: 'Checking your browser before accessing example.com', title: 'Just a moment...' }).run().blocker).toBe('Cloudflare')
    expect(makePage({ body: 'To continue, type the characters', href: 'https://www.google.com/sorry/index?x' }).run().blocker).toBe('Google')
    expect(makePage({ body: "This site can't be reached ERR_NAME_NOT_RESOLVED", errorPage: true }).run().netError).toBe('ERR_NAME_NOT_RESOLVED')
    expect(makePage({ href: 'chrome-error://chromewebdata/' }).run().netError).toBe('net error')
  })
})

describe('observerScript — network instrumentation', () => {
  it('wraps fetch once and reports requests in flight and failed since the action', async () => {
    const p = makePage({})
    const before = p.run({ baseline: true })
    // Two requests started after the baseline read.
    void p.fetch('https://app.com/cart/add.json')
    void p.fetch('https://api.other.com/v1/items')
    p.tick(300)
    let after = p.run({ since: before.t as number })
    expect(after.pending).toBe(2)
    expect(after.failed).toEqual([])
    p.resolveFetch(0, 422)
    p.resolveFetch(1, 200)
    await new Promise(r => setTimeout(r, 0))
    p.tick(200)
    after = p.run({ since: before.t as number })
    expect(after.pending).toBe(0)
    expect(after.failed).toEqual([{ url: '/cart/add.json', status: 422, initiator: 'fetch' }])
  })

  it('ignores requests from before the action and, without `since`, older than the recent window', async () => {
    const p = makePage({})
    p.run() // installs the instrumentation; requests before the first read are invisible by design
    void p.fetch('https://app.com/old')
    p.resolveFetch(0, 500)
    await new Promise(r => setTimeout(r, 0))
    p.tick(100)
    const before = p.run({ baseline: true })
    p.tick(300)
    expect(p.run({ since: before.t as number }).failed).toEqual([])
    // Status-line read (no since): the failure is within the last few seconds, so it shows.
    expect(p.run().failed).toEqual([{ url: '/old', status: 500, initiator: 'fetch' }])
    p.tick(10_000)
    expect(p.run().failed).toEqual([])
  })

  it('merges resource-timing failures and dedupes by url and status', () => {
    const p = makePage({ resources: [{ name: 'https://app.com/cart/add.json', startTime: 1200, responseStatus: 422, initiatorType: 'fetch' }, { name: 'https://cdn.x/a.js', startTime: 1300, responseStatus: 0 }] })
    const before = p.run({ baseline: true })
    p.tick(500)
    expect(p.run({ since: before.t as number }).failed).toEqual([{ url: '/cart/add.json', status: 422, initiator: 'fetch' }])
  })
})

describe('observerScript — busy signals', () => {
  it('reports semantic indicators: indeterminate progressbar, aria-busy, loading status text, wait cursor', () => {
    const { run } = makePage({
      sel: {
        [PROGRESS]: [el({ role: 'progressbar', label: 'Loading results' }), el({ role: 'progressbar', visible: false })],
        [ARIA_BUSY]: [el({}), el({})],
        [LIVE]: [el({ text: 'Loading your cart…' })],
      },
      cursor: 'wait',
    })
    expect(run().busy).toEqual([
      { kind: 'progressbar', name: 'Loading results', count: 1 },
      { kind: 'aria-busy', name: '', count: 2 },
      { kind: 'status', name: 'Loading your cart…', count: 1 },
      { kind: 'cursor', name: 'wait', count: 1 },
    ])
  })

  it('classifies new infinite animations by geometry and ignores ones already running at the baseline', () => {
    const spinner = el({ rect: { width: 24, height: 24, top: 300 } })
    const bar = el({ rect: { width: 1280, height: 3, top: 0 } })
    const marquee = el({ rect: { width: 600, height: 40, top: 800 } })
    const p = makePage({ animations: [{ target: marquee, currentTime: 50_000 }] })
    const before = p.run({ baseline: true })
    expect(before.busy).toEqual([]) // the marquee is old
    p.page.animations = [
      { target: marquee, currentTime: 50_300 },
      { target: spinner, currentTime: 250 },
      { target: bar, currentTime: 250 },
    ]
    p.tick(300)
    const after = p.run({ since: before.t as number })
    expect(after.busy).toEqual([{ kind: 'top-bar', name: '', count: 1 }, { kind: 'spinner', name: '', count: 1 }])
  })

  it('counts a spinner whose animation was running hidden at the baseline and became visible', () => {
    const state: FakeEl = { rect: { width: 24, height: 24, top: 300 }, checkVisibility: false }
    const hidden = el(state) // reads state.checkVisibility at call time, so the same element can be shown later
    const p = makePage({ animations: [{ target: hidden, currentTime: 9000 }] })
    const before = p.run({ baseline: true })
    state.checkVisibility = true
    p.page.animations = [{ target: hidden, currentTime: 9300 }]
    p.tick(300)
    expect(p.run({ since: before.t as number }).busy).toEqual([{ kind: 'spinner', name: '', count: 1 }])
  })

  it('groups many animated blocks as a skeleton, and skips paused or finite animations', () => {
    const blocks = [1, 2, 3, 4].map(() => el({ rect: { width: 300, height: 16, top: 200 } }))
    const p = makePage({ animations: [
      ...blocks.map(b => ({ target: b, currentTime: 100 })),
      { target: el({ rect: { width: 24, height: 24, top: 0 } }), currentTime: 100, running: false },
      { target: el({ rect: { width: 24, height: 24, top: 0 } }), currentTime: 100, infinite: false },
    ] })
    expect(p.run().busy).toEqual([{ kind: 'skeleton', name: '', count: 4 }])
  })

  it('without `since`, only animations younger than the recent window count', () => {
    const p = makePage({ animations: [{ target: el({ rect: { width: 24, height: 24, top: 0 } }), currentTime: 2000 }, { target: el({ rect: { width: 24, height: 24, top: 0 } }), currentTime: 20_000 }] })
    expect(p.run().busy).toEqual([{ kind: 'spinner', name: '', count: 1 }])
  })

  it('without `since`, ignores a decorative animation that started as the page loaded (a spinning logo is not a spinner)', () => {
    // Clock 1000, load ended at 800: an animation aged 250 started at 750, i.e. with the page.
    const logo = el({ rect: { width: 40, height: 40, top: 10 } })
    const late = el({ rect: { width: 24, height: 24, top: 300 } })
    const p = makePage({ loadEventEnd: 800, animations: [{ target: logo, currentTime: 250 }] })
    expect(p.run().busy).toEqual([])
    p.tick(2000) // clock 3000: a spinner that started at 2900 is real
    p.page.animations = [{ target: logo, currentTime: 2250 }, { target: late, currentTime: 100 }]
    expect(p.run().busy).toEqual([{ kind: 'spinner', name: '', count: 1 }])
  })

  it('calls a thin strip at the top a top bar whatever its current width', () => {
    const bar = el({ rect: { width: 256, height: 3, top: 0 } })
    const p = makePage({ animations: [] })
    const before = p.run({ baseline: true })
    p.page.animations = [{ target: bar, currentTime: 100 }]
    p.tick(300)
    expect(p.run({ since: before.t as number }).busy).toEqual([{ kind: 'top-bar', name: '', count: 1 }])
  })
})

describe('parseObservation', () => {
  it('parses double-encoded observer output with defaults for missing parts', () => {
    const raw = JSON.stringify(JSON.stringify({ url: 'https://a.com', httpStatus: 200, busy: [{ kind: 'spinner' }] }))
    expect(parseObservation(raw)).toEqual({ ...EMPTY_OBSERVATION, url: 'https://a.com', httpStatus: 200, busy: [{ kind: 'spinner', name: '', count: 1 }] })
  })

  it('accepts a forwarded observation unchanged and rejects garbage', () => {
    const obs: PageObservation = { ...EMPTY_OBSERVATION, url: 'https://a.com', liveRegions: ['Saved'], pending: 2 }
    expect(parseObservation(JSON.stringify(obs))).toEqual(obs)
    expect(parseObservation('✗ Error: Execution context was destroyed')).toBeNull()
    expect(parseObservation('[1,2]')).toBeNull()
    expect(parseObservation('{"url":5}')).toBeNull()
  })
})

describe('describeBusy / transientBusy', () => {
  it('reads like a person would say it', () => {
    expect(describeBusy([{ kind: 'spinner', name: '', count: 1 }, { kind: 'top-bar', name: '', count: 1 }, { kind: 'skeleton', name: '', count: 6 }, { kind: 'status', name: 'Loading…', count: 1 }], 2))
      .toBe('spinner, top bar, 6 skeletons, status "Loading…", 2 requests in flight')
    expect(describeBusy([], 1)).toBe('1 request in flight')
    expect(describeBusy([], 0)).toBe('')
  })

  it('treats permanent widgets (progressbar, aria-busy) as reportable but never waited on', () => {
    const obs: PageObservation = { ...EMPTY_OBSERVATION, busy: [{ kind: 'progressbar', name: '', count: 1 }, { kind: 'aria-busy', name: '', count: 1 }, { kind: 'spinner', name: '', count: 1 }] }
    expect(transientBusy(obs).map(b => b.kind)).toEqual(['spinner'])
  })
})
