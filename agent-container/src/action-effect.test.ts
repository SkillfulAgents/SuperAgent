import { describe, it, expect } from 'vitest'
import {
  fingerprintScript,
  parseFingerprint,
  diffFingerprints,
  formatActionEffect,
  type Fingerprint,
} from './action-effect'

// Minimal fake DOM for the fingerprint script: querySelectorAll by selector,
// activeElement, body.innerText, resource timing entries.
type FakeEl = {
  tag?: string; role?: string | null; text?: string; visible?: boolean; label?: string | null
  labelledby?: string | null; heading?: string | null; matchesPopover?: boolean
  placeholder?: string | null; name?: string | null; labels?: Array<{ innerText: string }>
}
function el(o: FakeEl) {
  const attrs: Record<string, string | null> = {
    role: o.role ?? null, 'aria-label': o.label ?? null, 'aria-labelledby': o.labelledby ?? null,
    placeholder: o.placeholder ?? null, name: o.name ?? null,
  }
  return {
    tagName: (o.tag ?? 'div').toUpperCase(),
    innerText: o.text ?? '',
    labels: o.labels,
    getAttribute: (k: string) => attrs[k] ?? null,
    getClientRects: () => (o.visible === false ? [] : [{}]),
    querySelector: (q: string) => (q.startsWith('h1') && o.heading ? { innerText: o.heading } : null),
    matches: (q: string) => q === ':popover-open' && Boolean(o.matchesPopover),
  }
}
type Page = {
  sel?: Record<string, unknown[]>; body?: string; active?: unknown; href?: string
  resources?: Array<{ name: string; startTime: number; responseStatus: number; initiatorType?: string }>
  now?: number; popoverThrows?: boolean; byId?: Record<string, { innerText: string }>
}
function run(page: Page, since?: number) {
  const body = { innerText: page.body ?? '' }
  const document = {
    body,
    activeElement: page.active ?? body,
    getElementById: (id: string) => page.byId?.[id] ?? null,
    querySelectorAll: (q: string) => {
      if (q === ':popover-open' && page.popoverThrows) throw new Error('unsupported selector')
      return page.sel?.[q] ?? []
    },
  }
  let cleared = false
  const performance = {
    now: () => page.now ?? 1000,
    clearResourceTimings: () => { cleared = true },
    getEntriesByType: () => page.resources ?? [],
  }
  const location = { href: page.href ?? 'https://app.com/x', host: 'app.com' }
  const fn = new Function('document', 'performance', 'location', 'URL', `return ${fingerprintScript(since)}`)
  const out = JSON.parse(fn(document, performance, location, URL))
  return { out, cleared }
}

const INTERACTIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[role="combobox"],[role="textbox"],[role="switch"],[role="slider"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
const TOP = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]'
const LIVE = '[role="alert"],[role="status"],[aria-live]:not([aria-live="off"]),output'

describe('fingerprintScript', () => {
  it('counts visible interactive elements, names open dialogs and reads live regions', () => {
    const { out } = run({
      sel: {
        [INTERACTIVE]: [el({ tag: 'button' }), el({ tag: 'a' }), el({ tag: 'button', visible: false })],
        [TOP]: [el({ tag: 'dialog', heading: 'Delete project?' }), el({ role: 'alertdialog', label: 'Confirm' }), el({ tag: 'dialog', visible: false })],
        [LIVE]: [el({ text: ' Tags  updated ' }), el({ text: '' })],
      },
      body: 'Hello world',
    })
    expect(out.interactive).toBe(2)
    expect(out.top).toEqual([{ kind: 'dialog', name: 'Delete project?' }, { kind: 'alertdialog', name: 'Confirm' }])
    expect(out.live).toEqual(['Tags updated'])
    expect(out.textLen).toBe(11)
    expect(typeof out.textHash).toBe('number')
    expect(out.focus).toBe('nothing focused')
    expect(out.url).toBe('https://app.com/x')
    expect(out.t).toBe(1000)
  })

  it('describes the focused element by role or tag and its accessible name', () => {
    expect(run({ active: el({ tag: 'input', labels: [{ innerText: 'Search' }] }) }).out.focus).toBe('input "Search"')
    expect(run({ active: el({ tag: 'div', role: 'textbox', label: 'Message' }) }).out.focus).toBe('textbox "Message"')
    expect(run({ active: el({ tag: 'button', text: 'Pay now' }) }).out.focus).toBe('button "Pay now"')
  })

  it('clears resource timings on the before read and collects failures since t0 on the after read', () => {
    const resources = [
      { name: 'https://app.com/cart/add.js', startTime: 1200, responseStatus: 422, initiatorType: 'fetch' },
      { name: 'https://app.com/old', startTime: 900, responseStatus: 500, initiatorType: 'fetch' },
      { name: 'https://cdn.x.com/a.js', startTime: 1300, responseStatus: 0, initiatorType: 'script' },
      { name: 'https://api.other.com/v1/items', startTime: 1400, responseStatus: 404, initiatorType: 'xmlhttprequest' },
    ]
    const before = run({ resources })
    expect(before.cleared).toBe(true)
    expect(before.out.failed).toEqual([])
    const after = run({ resources }, 1000)
    expect(after.cleared).toBe(false)
    expect(after.out.failed).toEqual([
      { url: '/cart/add.js', status: 422, initiator: 'fetch' },
      { url: 'api.other.com/v1/items', status: 404, initiator: 'xmlhttprequest' },
    ])
  })

  it('survives a browser without :popover-open', () => {
    const { out } = run({ popoverThrows: true, sel: { [TOP]: [el({ tag: 'dialog', text: 'Hi' })] } })
    expect(out.top).toEqual([{ kind: 'dialog', name: 'Hi' }])
  })
})

describe('parseFingerprint', () => {
  it('parses double-encoded output and drops malformed entries', () => {
    const raw = JSON.stringify(JSON.stringify({
      t: 12.5, url: 'https://a.com', interactive: 3, top: [{ kind: 'dialog', name: 'X' }, 'junk'],
      live: ['ok', 2], textLen: 10, textHash: -5, focus: 'button "Go"',
      failed: [{ url: '/a', status: 500, initiator: 'fetch' }, { url: '/b', status: 200 }],
    }))
    expect(parseFingerprint(raw)).toEqual({
      t: 12.5, url: 'https://a.com', interactive: 3, top: [{ kind: 'dialog', name: 'X' }],
      live: ['ok'], textLen: 10, textHash: -5, focus: 'button "Go"',
      failed: [{ url: '/a', status: 500, initiator: 'fetch' }],
    })
  })

  it('returns null on garbage', () => {
    expect(parseFingerprint('✗ Error')).toBeNull()
    expect(parseFingerprint('[]')).toBeNull()
  })
})

const base: Fingerprint = {
  t: 0, url: 'https://a.com', interactive: 40, top: [], live: [], textLen: 500, textHash: 1, focus: 'nothing focused', failed: [],
}

describe('diffFingerprints + formatActionEffect', () => {
  it('reports a dialog opening with its census and announcement', () => {
    const after: Fingerprint = {
      ...base, interactive: 52, textLen: 620, textHash: 2,
      top: [{ kind: 'dialog', name: 'Create new app' }], live: ['Tags updated successfully'],
    }
    const effect = diffFingerprints(base, after)
    expect(effect.opened).toEqual([{ kind: 'dialog', name: 'Create new app' }])
    expect(formatActionEffect(effect, { settleMs: 300, verb: 'click' })).toBe(
      '\nEffect: dialog "Create new app" opened · announced: "Tags updated successfully" · +12 interactive elements',
    )
  })

  it('reports a dialog closing and a failed request', () => {
    const before: Fingerprint = { ...base, top: [{ kind: 'dialog', name: 'Cart' }] }
    const after: Fingerprint = { ...base, failed: [{ url: '/cart/add.js', status: 422, initiator: 'fetch' }], live: ['Cart Error'] }
    expect(formatActionEffect(diffFingerprints(before, after), { settleMs: 300, verb: 'click' })).toBe(
      '\nEffect: dialog "Cart" closed · announced: "Cart Error" · failed request: fetch /cart/add.js → 422',
    )
  })

  it('does not re-announce a live region that was already showing', () => {
    const before: Fingerprint = { ...base, live: ['Saved'] }
    const after: Fingerprint = { ...base, live: ['Saved'], textHash: 9 }
    expect(formatActionEffect(diffFingerprints(before, after), { settleMs: 300, verb: 'click' })).toBe('\nEffect: page text changed')
  })

  it('says no DOM change, with the window and a verb-specific hint, when nothing moved', () => {
    const out = formatActionEffect(diffFingerprints(base, { ...base }), { settleMs: 300, verb: 'click' })
    expect(out).toBe('\nEffect: no DOM change within 300ms — the element may not be handling clicks (disabled, covered, or needs a different target). Check its state, or browser_wait for what you expect to appear.')
    expect(formatActionEffect(diffFingerprints(base, { ...base }), { settleMs: 300, verb: 'hover' })).toContain('nothing opened on hover')
  })

  it('always reports focus for press, and treats a focus move as a change', () => {
    const moved = diffFingerprints(base, { ...base, focus: 'textbox "Search"' })
    expect(formatActionEffect(moved, { settleMs: 50, verb: 'press' })).toBe('\nEffect: focus: textbox "Search"')
    const stayed = diffFingerprints({ ...base, focus: 'textbox "Search"' }, { ...base, focus: 'textbox "Search"' })
    expect(formatActionEffect(stayed, { settleMs: 50, verb: 'press' })).toBe(
      '\nEffect: no DOM change within 50ms — the key may have been ignored by the focused element. Check what is focused, or browser_wait for what you expect to appear. (focus: textbox "Search")',
    )
    const typed = diffFingerprints({ ...base, focus: 'textbox "Search"' }, { ...base, focus: 'textbox "Search"', interactive: 45 })
    expect(formatActionEffect(typed, { settleMs: 50, verb: 'press' })).toBe('\nEffect: +5 interactive elements · focus: textbox "Search"')
  })

  it('is empty without an effect (eval failed or page navigated)', () => {
    expect(formatActionEffect(null, { settleMs: 300, verb: 'click' })).toBe('')
  })
})
