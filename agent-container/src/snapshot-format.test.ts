import { describe, it, expect } from 'vitest'
import {
  parseIframeInfo,
  formatIframePlaceholders,
  capSnapshot,
  compactWithText,
  formatTextFooter,
  countRefs,
  SNAPSHOT_SOFT_CAP_CHARS,
  TEXT_FOOTER_MIN_CHARS,
  type IframeInfo,
} from './snapshot-format'
import { EMPTY_OBSERVATION } from './page-observer'

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
  const stripe: IframeInfo = { title: 'Secure payment input frame', host: 'js.stripe.com', sameOrigin: false }
  // Real CLI tree (agent-browser 0.27.2): a cross-origin frame merged with refs.
  const mergedTree = [
    '- textbox "Name " [ref=e5]',
    '- Iframe "Secure payment input frame" [ref=e2]',
    '  - textbox "Card number " [ref=e7]',
    '  - button "Pay" [ref=e6]',
    '- button "Submit" [ref=e4]',
  ].join('\n')

  it('says nothing about a frame whose contents are in the tree, cross-origin or not', () => {
    expect(formatIframePlaceholders([stripe], mergedTree)).toBe('')
  })

  it('lists a frame the tree does not carry, as a fact and without a recipe', () => {
    const out = formatIframePlaceholders([stripe], '- textbox "Name " [ref=e5]\n- button "Submit" [ref=e4]')
    expect(out).toContain('whose contents are not in this tree')
    expect(out).toContain('iframe "Secure payment input frame" (js.stripe.com) · cross-origin')
    for (const claim of ['NOT in this snapshot', 'coordinates', 'browser_type', 'card number']) {
      expect(out).not.toContain(claim)
    }
  })

  it('lists a frame that is in the tree but empty', () => {
    const emptyTree = '- Iframe "Secure payment input frame" [ref=e2]\n- button "Submit" [ref=e4]'
    expect(formatIframePlaceholders([stripe], emptyTree)).toContain('iframe "Secure payment input frame" (js.stripe.com)')
  })

  it('marks a same-origin frame the tree could not read without the cross-origin label', () => {
    const out = formatIframePlaceholders([{ title: 'inner', host: 'self.com', sameOrigin: true }], '')
    expect(out).toContain('iframe "inner" (self.com)')
    expect(out).not.toContain('cross-origin')
  })

  it('takes an untitled DOM frame as merged when the tree has an untitled Iframe with children', () => {
    const tree = '- Iframe [ref=e2]\n  - button "Go" [ref=e3]'
    expect(formatIframePlaceholders([{ title: '', host: 'ads.example', sameOrigin: false }], tree)).toBe('')
    expect(formatIframePlaceholders([{ title: '', host: 'ads.example', sameOrigin: false }], '- Iframe [ref=e2]')).toContain('(ads.example)')
  })

  it('omits srcless/blank frames (no host)', () => {
    expect(formatIframePlaceholders([{ title: '', host: '', sameOrigin: false }], '')).toBe('')
  })

  it('returns empty string when there are no frames', () => {
    expect(formatIframePlaceholders([], '')).toBe('')
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

describe('countRefs', () => {
  it('counts ref tokens in any attribute position', () => {
    expect(countRefs('- link "a" [ref=e1]\n- heading "b" [level=1, ref=e2]\n- StaticText "ref=e3 in text"')).toBe(3)
    expect(countRefs('(no interactive elements)')).toBe(0)
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

  it('merges runs exactly as the page has them — the whitespace between inline elements is its own node and is kept', () => {
    // Captured from agent-browser 0.27.2 for
    // `Visit example.<strong>com</strong> and never run <code>rm</code> <code>-rf</code> there. <strong>Never</strong> <em>delete</em> <code>backups</code>.`
    const tree = [
      '- paragraph',
      '  - StaticText "Visit example."',
      '  - strong',
      '    - StaticText "com"',
      '  - StaticText " and never run "',
      '  - code',
      '    - StaticText "rm"',
      '  - StaticText " "',
      '  - code',
      '    - StaticText "-rf"',
      '  - StaticText " there. "',
      '  - strong',
      '    - StaticText "Never"',
      '  - StaticText " "',
      '  - emphasis',
      '    - StaticText "delete"',
      '  - StaticText " "',
      '  - code',
      '    - StaticText "backups"',
      '  - StaticText "."',
    ].join('\n')
    expect(compactWithText(tree).split('\n')).toEqual(['- paragraph', '  - StaticText "Visit example.com and never run rm -rf there. Never delete backups."'])
    // A blank text node under an otherwise empty container is not prose.
    expect(compactWithText(['- generic', '  - StaticText " "', '- link "x" [ref=e1]'].join('\n'))).toBe('- link "x" [ref=e1]')
  })

  it('keeps a multi-line textarea value on its node and does not repeat it as text', () => {
    // Captured from agent-browser 0.27.2: the value renders with raw newlines,
    // and the lines repeat beneath as text with LineBreak nodes between them.
    const tree = [
      '- LabelText',
      '  - StaticText "Notes "',
      '  - textbox "Notes " [ref=e3]: line one',
      'line two',
      'line three',
      '    - generic',
      '      - StaticText "line one"',
      '      - LineBreak "\\n"',
      '      - StaticText "line two"',
      '      - LineBreak "\\n"',
      '      - StaticText "line three"',
      '- paragraph',
      '  - StaticText "First"',
      '  - LineBreak "\\n"',
      '  - StaticText "second"',
    ].join('\n')
    expect(compactWithText(tree)).toBe([
      '- LabelText',
      '  - textbox "Notes " [ref=e3]: line one',
      'line two',
      'line three',
      '- paragraph',
      '  - StaticText "First\\nsecond"',
    ].join('\n'))
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
  const obs = { ...EMPTY_OBSERVATION, textChars: 4200, preview: 'Welcome to Acme and much more text', liveRegions: ['Saved', 'Email is required'] }

  it('is empty in fullText mode (the text is in the tree)', () => {
    expect(formatTextFooter(obs, { fullText: true, scoped: false })).toBe('')
  })

  it('names the dropped text, its size, a preview and the fullText knob', () => {
    const out = formatTextFooter(obs, { fullText: false, scoped: false })
    expect(out).toContain('Live regions (alert/status): "Saved" | "Email is required"')
    expect(out).toContain('~4,200 chars')
    expect(out).toContain('Starts: "Welcome to Acme and much more text"')
    expect(out).toContain('fullText:true')
    expect(out).toContain('scope:')
    expect(out.startsWith('\n\n')).toBe(true)
  })

  it('trims the preview to what this view should show', () => {
    expect(formatTextFooter(obs, { fullText: false, scoped: false, previewChars: 15 })).toContain('Starts: "Welcome to Acme"')
  })

  it('stays quiet on pages with almost no text and no live regions', () => {
    expect(formatTextFooter({ ...EMPTY_OBSERVATION, textChars: TEXT_FOOTER_MIN_CHARS - 1 }, { fullText: false, scoped: false })).toBe('')
  })

  it('still surfaces live regions on a near-empty page', () => {
    const out = formatTextFooter({ ...EMPTY_OBSERVATION, liveRegions: ['Loading…'] }, { fullText: false, scoped: true })
    expect(out).toBe('\n\nLive regions (alert/status): "Loading…"')
  })
})
