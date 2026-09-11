import { describe, it, expect } from 'vitest'
import {
  parseIframeInfo,
  formatIframePlaceholders,
  capSnapshot,
  parsePageProbe,
  compactWithText,
  formatTextFooter,
  formatStatusHeader,
  pageWarnings,
  countRefs,
  landedElsewhere,
  pageProbeScript,
  PAGE_PROBE_SCRIPT,
  EMPTY_PROBE,
  THIN_TREE_PREVIEW_CHARS,
  SNAPSHOT_SOFT_CAP_CHARS,
  TEXT_FOOTER_MIN_CHARS,
  PREVIEW_CHARS,
  type IframeInfo,
} from './snapshot-format'

describe('parseIframeInfo', () => {
  it('parses CLI double-encoded eval output', () => {
    const raw = JSON.stringify(JSON.stringify([
      { title: 'Secure payment input frame', host: 'js.stripe.com', sameOrigin: false },
    ]))
    expect(parseIframeInfo(raw)).toEqual([
      { title: 'Secure payment input frame', host: 'js.stripe.com', sameOrigin: false },
    ])
  })

  it('parses plain JSON and fills missing fields', () => {
    expect(parseIframeInfo('[{"host":"x.com"}]')).toEqual([
      { title: '', host: 'x.com', sameOrigin: false },
    ])
  })

  it('returns [] on garbage or non-arrays', () => {
    expect(parseIframeInfo('✗ error')).toEqual([])
    expect(parseIframeInfo('"not an array"')).toEqual([])
  })
})

describe('formatIframePlaceholders', () => {
  it('lists cross-origin frames with the payment recipe', () => {
    const frames: IframeInfo[] = [{ title: 'Secure payment input frame', host: 'js.stripe.com', sameOrigin: false }]
    const out = formatIframePlaceholders(frames)
    expect(out).toContain('js.stripe.com')
    expect(out).toContain('Secure payment input frame')
    expect(out).toContain('browser_type')
  })

  it('omits same-origin frames (already merged into the tree)', () => {
    const frames: IframeInfo[] = [{ title: 'inner', host: 'self.com', sameOrigin: true }]
    expect(formatIframePlaceholders(frames)).toBe('')
  })

  it('omits srcless/blank frames (no host)', () => {
    expect(formatIframePlaceholders([{ title: '', host: '', sameOrigin: false }])).toBe('')
  })

  it('returns empty string when there are no opaque frames', () => {
    expect(formatIframePlaceholders([])).toBe('')
  })
})

describe('capSnapshot', () => {
  it('passes through snapshots under the cap', () => {
    expect(capSnapshot('- button "x" [ref=e1]', false)).toBe('- button "x" [ref=e1]')
  })

  it('truncates over-cap snapshots and suggests scope', () => {
    const out = capSnapshot('e'.repeat(SNAPSHOT_SOFT_CAP_CHARS + 5000), false)
    expect(out.length).toBeLessThan(SNAPSHOT_SOFT_CAP_CHARS + 300)
    expect(out).toContain('snapshot truncated')
    expect(out).toContain('scope=')
  })

  it('gives a tighter-scope hint when already scoped', () => {
    const out = capSnapshot('e'.repeat(SNAPSHOT_SOFT_CAP_CHARS + 5000), true)
    expect(out).toContain('tighter scope')
  })
})

describe('parsePageProbe', () => {
  it('parses CLI double-encoded probe output', () => {
    const raw = JSON.stringify(JSON.stringify({
      iframes: [{ title: 'pay', host: 'js.stripe.com', sameOrigin: false }],
      textChars: 4200,
      live: ['Password must be at least 8 characters'],
      preview: 'Welcome back',
    }))
    expect(parsePageProbe(raw)).toEqual({
      ...EMPTY_PROBE,
      iframes: [{ title: 'pay', host: 'js.stripe.com', sameOrigin: false }],
      textChars: 4200,
      liveRegions: ['Password must be at least 8 characters'],
      preview: 'Welcome back',
    })
  })

  it('parses the identity and readiness fields', () => {
    const out = parsePageProbe(JSON.stringify({
      url: 'https://a.com/x', title: 'A', readyState: 'complete', http: 429, contentType: 'text/html',
      busy: 2, blocker: 'Cloudflare', netError: '',
    }))
    expect(out).toMatchObject({
      url: 'https://a.com/x', title: 'A', readyState: 'complete', httpStatus: 429, contentType: 'text/html',
      busy: 2, blocker: 'Cloudflare', netError: '',
    })
  })

  it('defaults missing or malformed parts', () => {
    expect(parsePageProbe('{"textChars":"x","live":[1,"ok",""],"preview":null,"http":"200"}')).toEqual({
      ...EMPTY_PROBE, liveRegions: ['ok'],
    })
  })

  it('returns the empty probe on garbage, arrays or eval errors', () => {
    expect(parsePageProbe('✗ Error: Execution context was destroyed')).toEqual(EMPTY_PROBE)
    expect(parsePageProbe('[1,2]')).toEqual(EMPTY_PROBE)
    expect(parsePageProbe('')).toEqual(EMPTY_PROBE)
  })
})

describe('PAGE_PROBE_SCRIPT', () => {
  // Minimal fake DOM: enough for the script's querySelectorAll/innerText/getClientRects calls.
  function el(o: { text?: string; visible?: boolean; src?: string; title?: string; sameOrigin?: boolean }) {
    return {
      innerText: o.text ?? '',
      title: o.title ?? '',
      src: o.src ?? '',
      offsetParent: o.visible === false ? null : {},
      getClientRects: () => (o.visible === false ? [] : [{}]),
      get contentDocument() {
        if (o.sameOrigin) return {}
        throw new Error('cross-origin')
      },
    }
  }
  const LIVE_SELECTOR = '[role="alert"],[role="status"],[aria-live]:not([aria-live="off"]),output'
  const BUSY_SELECTOR = '[aria-busy="true"],[role="progressbar"],[class*="skeleton"]'
  type FakeDoc = {
    title?: string; readyState?: string; contentType?: string; errorPage?: boolean
    href?: string; status?: number; script?: string
  }
  function run(sel: Record<string, unknown[]>, body: { innerText: string }, main: unknown = null, doc: FakeDoc = {}) {
    const document = {
      body,
      title: doc.title ?? '',
      readyState: doc.readyState ?? 'complete',
      contentType: doc.contentType ?? 'text/html',
      querySelectorAll: (q: string) => sel[q] ?? [],
      querySelector: (q: string) => (q === 'main,[role=main]' ? main : null),
      getElementById: (id: string) => (id === 'main-frame-error' && doc.errorPage ? {} : null),
    }
    const location = { href: doc.href ?? 'https://example.com/page' }
    const performance = { getEntriesByType: () => [{ responseStatus: doc.status ?? 200 }] }
    const fn = new Function('document', 'URL', 'location', 'performance', `return ${doc.script ?? PAGE_PROBE_SCRIPT}`)
    return JSON.parse(fn(document, URL, location, performance))
  }

  it('reports text length, live regions, preview and iframes in one object', () => {
    const out = run(
      {
        iframe: [el({ src: 'https://js.stripe.com/v3/elements', title: 'Secure payment', visible: true })],
        [LIVE_SELECTOR]: [
          el({ text: '  Email is   required ' }),
          el({ text: 'Email is required' }),          // duplicate after whitespace collapse
          el({ text: 'hidden toast', visible: false }), // no client rects → skipped
          el({ text: '' }),                            // empty live region placeholder → skipped
        ],
      },
      { innerText: 'Hello\n\n  world  ' },
      { innerText: 'Main   content ' + 'x'.repeat(500) },
    )
    expect(out.iframes).toEqual([{ title: 'Secure payment', host: 'js.stripe.com', sameOrigin: false }])
    expect(out.textChars).toBe('Hello world'.length)
    expect(out.live).toEqual(['Email is required'])
    expect(out.preview.startsWith('Main content x')).toBe(true)
    expect(out.preview.length).toBe(PREVIEW_CHARS)
  })

  it('reports identity and readiness: url, title, readyState, HTTP status, content type', () => {
    const out = run({}, { innerText: 'x' }, null, { title: ' Acme  Shop ', readyState: 'interactive', status: 404, href: 'https://acme.com/a?b=1' })
    expect(out).toMatchObject({ url: 'https://acme.com/a?b=1', title: 'Acme Shop', readyState: 'interactive', http: 404, contentType: 'text/html', busy: 0, blocker: '', netError: '' })
  })

  it('counts visible loading indicators only', () => {
    const out = run({ [BUSY_SELECTOR]: [el({ text: 'a' }), el({ text: 'b', visible: false }), el({ text: 'c' })] }, { innerText: 'x' })
    expect(out.busy).toBe(2)
  })

  it('recognises bot walls by vendor signature, including Google via the URL', () => {
    expect(run({}, { innerText: 'Checking your browser before accessing example.com. Ray ID: 8f3' }, null, { title: 'Just a moment...' }).blocker).toBe('Cloudflare')
    expect(run({}, { innerText: 'Access denied. Error 15. Incident ID: 123-456' }).blocker).toBe('Imperva/Incapsula')
    expect(run({}, { innerText: "You don't have permission to access \"/\" on this server. Reference #18.4f2e1cb8.1725" }).blocker).toBe('Akamai')
    expect(run({}, { innerText: 'To continue, please type the characters below' }, null, { href: 'https://www.google.com/sorry/index?continue=x' }).blocker).toBe('Google')
    expect(run({}, { innerText: 'Please Press & Hold to confirm you are a human' }).blocker).toBe('PerimeterX')
    expect(run({}, { innerText: 'Welcome to our store. Prices in USD.' }, null, { title: 'Store' }).blocker).toBe('')
  })

  it("names Chrome's net error page by its ERR_ code", () => {
    const out = run({}, { innerText: "This site can't be reached. example.com's server IP address could not be found. ERR_NAME_NOT_RESOLVED" }, null, { errorPage: true })
    expect(out.netError).toBe('ERR_NAME_NOT_RESOLVED')
    expect(run({}, { innerText: 'fine' }).netError).toBe('')
    // Headless shell: empty error document, only the URL gives it away (captured in the container image).
    expect(run({}, { innerText: '' }, null, { href: 'chrome-error://chromewebdata/' }).netError).toBe('net error')
  })

  it('takes a longer preview when asked (thin trees)', () => {
    const out = run({}, { innerText: 'y'.repeat(3000) }, null, { script: pageProbeScript({ previewChars: THIN_TREE_PREVIEW_CHARS }) })
    expect(out.preview.length).toBe(THIN_TREE_PREVIEW_CHARS)
  })

  it('falls back to body for the preview and survives a broken part', () => {
    const document = {
      body: { innerText: 'Body text here' },
      querySelectorAll: (q: string) => { if (q === 'iframe') throw new Error('boom'); return [] },
      querySelector: () => null,
    }
    const fn = new Function('document', 'URL', `return ${PAGE_PROBE_SCRIPT}`)
    const out = JSON.parse(fn(document, URL))
    expect(out.iframes).toEqual([])
    expect(out.textChars).toBe(14)
    expect(out.preview).toBe('Body text here')
    expect(out.url).toBe('')
    expect(out.http).toBe(0)
  })
})

describe('pageWarnings / formatStatusHeader', () => {
  const healthy = { ...EMPTY_PROBE, url: 'https://acme.com/checkout', title: 'Checkout — Acme', readyState: 'complete', httpStatus: 200, contentType: 'text/html' }

  it('is one clean line for a healthy page', () => {
    expect(pageWarnings(healthy, 84)).toEqual([])
    expect(formatStatusHeader(healthy, 84)).toBe('[page] https://acme.com/checkout · "Checkout — Acme" · HTTP 200 · complete · 84 refs')
  })

  it('omits HTTP when unknown and refs when not counted, and is empty without a URL', () => {
    expect(formatStatusHeader({ ...healthy, httpStatus: 0, title: '' }, null)).toBe('[page] https://acme.com/checkout · untitled · complete')
    expect(formatStatusHeader(EMPTY_PROBE, 3)).toBe('')
  })

  it('warns, most invalidating first, with the action to take', () => {
    const bad = { ...healthy, httpStatus: 429, blocker: 'Cloudflare', readyState: 'loading', busy: 3 }
    const warns = pageWarnings(bad, 0)
    expect(warns.map(w => w.split(' ')[0])).toEqual(['bot-block:', 'HTTP', 'page', '3'])
    expect(warns[0]).toContain('request_browser_input')
    expect(warns[1]).toContain('rate limited')
    const header = formatStatusHeader(bad, 0)
    expect(header.split('\n')).toHaveLength(5)
    expect(header).toContain('\n⚠ bot-block: Cloudflare')
  })

  it('explains an empty tree only when nothing else does', () => {
    expect(pageWarnings(healthy, 0)[0]).toContain('no interactive elements')
    expect(pageWarnings({ ...healthy, netError: 'ERR_CONNECTION_REFUSED' }, 0)).toHaveLength(1)
    expect(pageWarnings({ ...healthy, netError: 'ERR_CONNECTION_REFUSED' }, 0)[0]).toContain('site unreachable (ERR_CONNECTION_REFUSED)')
    expect(pageWarnings({ ...healthy, netError: 'net error' }, 0)[0]).toMatch(/^site unreachable — /)
  })

  it('flags 401/403/404 and non-HTML documents', () => {
    expect(pageWarnings({ ...healthy, httpStatus: 401 }, 1)[0]).toContain('login or permission required')
    expect(pageWarnings({ ...healthy, httpStatus: 404 }, 1)[0]).toContain('not found')
    expect(pageWarnings({ ...healthy, contentType: 'application/json' }, 1)[0]).toContain('raw application/json document')
  })
})

describe('countRefs / landedElsewhere', () => {
  it('counts ref tokens in any attribute position', () => {
    expect(countRefs('- link "a" [ref=e1]\n- heading "b" [level=1, ref=e2]\n- StaticText "ref=e3 in text"')).toBe(3)
    expect(countRefs('(no interactive elements)')).toBe(0)
  })

  it('ignores scheme, trailing slash, fragment and host case', () => {
    expect(landedElsewhere('example.com', 'https://example.com/')).toBe(false)
    expect(landedElsewhere('http://Example.com/a/', 'https://example.com/a#top')).toBe(false)
  })

  it('detects redirects to another path or host', () => {
    expect(landedElsewhere('https://app.com/dashboard', 'https://app.com/login?next=%2Fdashboard')).toBe(true)
    expect(landedElsewhere('https://a.com', 'https://b.com')).toBe(true)
    expect(landedElsewhere('not a url', 'https://b.com')).toBe(false)
  })
})

describe('compactWithText', () => {
  const full = [
    '- banner',
    '  - link "Home" [ref=e1]',
    '- main',
    '  - heading "Checkout" [level=1, ref=e2]',
    '  - generic',
    '    - list',
    '      - listitem',
    '        - generic',
    '  - paragraph',
    '    - StaticText "Total: $42.00"',
    '  - alert',
    '    - StaticText "Card declined"',
    '  - textbox "Card number" [ref=e3]: 4242',
    '  - image "Product photo"',
    '  - image',
    '- contentinfo',
    '  - list',
    '    - listitem',
  ].join('\n')

  it('keeps refs, StaticText, values and named images with their ancestors, drops bare structure', () => {
    expect(compactWithText(full).split('\n')).toEqual([
      '- banner',
      '  - link "Home" [ref=e1]',
      '- main',
      '  - heading "Checkout" [level=1, ref=e2]',
      '  - paragraph',
      '    - StaticText "Total: $42.00"',
      '  - alert',
      '    - StaticText "Card declined"',
      '  - textbox "Card number" [ref=e3]: 4242',
      '  - image "Product photo"',
    ])
  })

  it('marks only true ancestors, not earlier siblings at a lower depth', () => {
    const tree = ['- a', '  - b', '    - c', '  - d', '    - StaticText "kept"'].join('\n')
    expect(compactWithText(tree)).toBe(['- a', '  - d', '    - StaticText "kept"'].join('\n'))
  })

  it('passes sentinels and text-free trees through unchanged', () => {
    expect(compactWithText('(empty page)')).toBe('(empty page)')
    expect(compactWithText('- generic\n  - list\n')).toBe('- generic\n  - list')
  })

  it('re-joins prose split by inline wrappers, including nested ones', () => {
    const tree = [
      '- paragraph',
      '  - StaticText "Total "',
      '  - strong',
      '    - emphasis',
      '      - StaticText "$42"',
      '  - StaticText " due "',
      '  - link "today" [ref=e1]',
      '  - StaticText "."',
    ].join('\n')
    expect(compactWithText(tree).split('\n')).toEqual([
      '- paragraph',
      '  - StaticText "Total $42 due "',
      '  - link "today" [ref=e1]',
      '  - StaticText "."',
    ])
  })

  it('keeps a wrapper that also contains a control', () => {
    const tree = ['- strong', '  - StaticText "Go "', '  - link "here" [ref=e1]'].join('\n')
    expect(compactWithText(tree).split('\n')).toEqual(['- strong', '  - StaticText "Go "', '  - link "here" [ref=e1]'])
  })

  // Captured from agent-browser 0.27.2 (`snapshot` with no flags) inside the
  // container image, against a checkout-like test page. This is exactly what
  // fullText fetches; the expectation is what the agent should read.
  const CAPTURED_FULL_TREE = `- banner
  - navigation
    - link "Home" [ref=e4]
    - StaticText " "
    - link "Shop" [ref=e5]
- main
  - heading "Checkout" [level=1, ref=e2]
  - paragraph
    - StaticText "Your order total is "
    - strong
      - StaticText "$42.00"
    - StaticText " including tax. Delivery on "
    - emphasis
      - StaticText "Friday"
    - StaticText "."
  - list
    - listitem [level=1]
      - ListMarker "• "
      - StaticText "Item A — $20.00"
    - listitem [level=1]
      - ListMarker "• "
      - StaticText "Item B — $22.00"
  - table
    - row
      - columnheader "SKU" [ref=e7]
      - columnheader "Price" [ref=e8]
    - row
      - cell "A-1" [ref=e9]
      - cell "$20.00" [ref=e10]
  - form
    - LabelText
      - StaticText "Card number "
      - textbox "Card number " [ref=e11]: 4242
        - StaticText "4242"
    - alert
      - StaticText "Card declined — try another card"
    - button "Pay now" [ref=e6]
  - image "Product photo"
- status
  - StaticText "Saved 2 seconds ago"
- contentinfo
  - link "Privacy" [ref=e3]
  - StaticText "© 2026 Acme"
- Iframe "Secure payment" [ref=e1]
  - heading "Example Domain" [level=1, ref=e12]
  - paragraph
    - StaticText "This domain is for use in documentation examples without needing permission. Avoid use in operations."
  - paragraph
    - link "Learn more" [ref=e13]`

  it('turns a real full tree into a readable compact tree', () => {
    expect(compactWithText(CAPTURED_FULL_TREE)).toBe(`- banner
  - navigation
    - link "Home" [ref=e4]
    - link "Shop" [ref=e5]
- main
  - heading "Checkout" [level=1, ref=e2]
  - paragraph
    - StaticText "Your order total is $42.00 including tax. Delivery on Friday."
  - list
    - listitem [level=1]
      - StaticText "Item A — $20.00"
    - listitem [level=1]
      - StaticText "Item B — $22.00"
  - table
    - row
      - columnheader "SKU" [ref=e7]
      - columnheader "Price" [ref=e8]
    - row
      - cell "A-1" [ref=e9]
      - cell "$20.00" [ref=e10]
  - form
    - LabelText
      - textbox "Card number " [ref=e11]: 4242
    - alert
      - StaticText "Card declined — try another card"
    - button "Pay now" [ref=e6]
  - image "Product photo"
- status
  - StaticText "Saved 2 seconds ago"
- contentinfo
  - link "Privacy" [ref=e3]
  - StaticText "© 2026 Acme"
- Iframe "Secure payment" [ref=e1]
  - heading "Example Domain" [level=1, ref=e12]
  - paragraph
    - StaticText "This domain is for use in documentation examples without needing permission. Avoid use in operations."
  - paragraph
    - link "Learn more" [ref=e13]`)
  })
})

describe('formatTextFooter', () => {
  const probe = { ...EMPTY_PROBE, textChars: 4200, preview: 'Welcome to Acme', liveRegions: ['Saved', 'Email is required'] }

  it('is empty in fullText mode (the text is in the tree)', () => {
    expect(formatTextFooter(probe, { fullText: true, scoped: false })).toBe('')
  })

  it('names the dropped text, its size, a preview and the fullText knob', () => {
    const out = formatTextFooter(probe, { fullText: false, scoped: false })
    expect(out).toContain('Live regions (alert/status): "Saved" | "Email is required"')
    expect(out).toContain('~4,200 chars')
    expect(out).toContain('Starts: "Welcome to Acme"')
    expect(out).toContain('fullText:true')
    expect(out).toContain('scope:')
    expect(out.startsWith('\n\n')).toBe(true)
  })

  it('stays quiet on pages with almost no text and no live regions', () => {
    expect(formatTextFooter({ ...EMPTY_PROBE, textChars: TEXT_FOOTER_MIN_CHARS - 1 }, { fullText: false, scoped: false })).toBe('')
  })

  it('still surfaces live regions on a near-empty page', () => {
    const out = formatTextFooter({ ...EMPTY_PROBE, liveRegions: ['Loading…'] }, { fullText: false, scoped: true })
    expect(out).toBe('\n\nLive regions (alert/status): "Loading…"')
  })
})
