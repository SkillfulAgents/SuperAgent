import { describe, it, expect, beforeEach } from 'vitest'
import {
  observeUrl,
  resetUrlTracking,
  formatUrlDigest,
  formatUrlDigestBrief,
  formatFillReadback,
  parseScrollInfo,
  formatScrollDigest,
} from './browser-digest'

describe('observeUrl', () => {
  beforeEach(() => resetUrlTracking())

  it('first observation is not a navigation, and is flagged as first', () => {
    expect(observeUrl('https://a.com/')).toEqual({ url: 'https://a.com/', navigated: false, firstObservation: true })
  })

  it('same URL twice is not a navigation', () => {
    observeUrl('https://a.com/')
    expect(observeUrl('https://a.com/').navigated).toBe(false)
  })

  it('detects navigation, including ones that happened between actions', () => {
    observeUrl('https://a.com/')
    expect(observeUrl('https://a.com/checkout')).toEqual({ url: 'https://a.com/checkout', navigated: true, firstObservation: false })
    // late navigation surfaces on the NEXT action's digest
    expect(observeUrl('https://stripe.com/pay').navigated).toBe(true)
  })

  it('regression: open-seeded baseline makes the first click navigation detectable', () => {
    // validation run found: open(data:...) reset but never seeded the baseline,
    // so a click that navigated to example.com was reported "URL unchanged"
    observeUrl('data:text/html,<a href=...>')   // seeded at /browser/open
    const afterClick = observeUrl('https://example.com/')
    expect(afterClick.navigated).toBe(true)
    expect(formatUrlDigest(afterClick)).toContain('NAVIGATED')
  })

  it('resetUrlTracking clears history (browser reopen)', () => {
    observeUrl('https://a.com/')
    resetUrlTracking()
    expect(observeUrl('https://b.com/').navigated).toBe(false)
  })
})

describe('formatUrlDigest', () => {
  it('warns about stale refs on navigation', () => {
    const msg = formatUrlDigest({ url: 'https://a.com/done', navigated: true, firstObservation: false })
    expect(msg).toContain('NAVIGATED')
    expect(msg).toContain('https://a.com/done')
    expect(msg).toContain('stale')
  })

  it('reports the URL when unchanged', () => {
    const msg = formatUrlDigest({ url: 'https://a.com/', navigated: false, firstObservation: false })
    expect(msg).toContain('URL unchanged (https://a.com/)')
  })

  it('never claims "unchanged" without a baseline', () => {
    const msg = formatUrlDigest({ url: 'https://a.com/', navigated: false, firstObservation: true })
    expect(msg).toContain('Now at https://a.com/')
    expect(msg).not.toContain('unchanged')
    expect(formatUrlDigestBrief({ url: 'https://a.com/', navigated: false, firstObservation: true })).toContain('now at')
  })

  it('brief variant is quiet when unchanged, loud on navigation', () => {
    expect(formatUrlDigestBrief({ url: 'https://a.com/', navigated: false, firstObservation: false })).toBe(' (URL unchanged)')
    expect(formatUrlDigestBrief({ url: 'https://a.com/x', navigated: true, firstObservation: false })).toContain('NAVIGATED')
  })

  it('renders nothing when the digest is unavailable', () => {
    expect(formatUrlDigest(null)).toBe('')
    expect(formatUrlDigestBrief(null)).toBe('')
  })
})

describe('formatFillReadback', () => {
  it('verifies a committed value', () => {
    expect(formatFillReadback('hello', 'hello')).toContain('verified: "hello"')
  })

  it('warns on divergence (maxlength truncation, reformatting, rejection)', () => {
    const msg = formatFillReadback('x'.repeat(100), 'x'.repeat(75))
    expect(msg).toContain('⚠')
    expect(msg).toContain('differs from the requested')
  })

  it('says so when the value cannot be read back', () => {
    expect(formatFillReadback('hello', null)).toContain('could not read')
  })

  it('caps displayed values', () => {
    const msg = formatFillReadback('y'.repeat(500), 'y'.repeat(500))
    expect(msg.length).toBeLessThan(200)
  })
})

describe('parseScrollInfo / formatScrollDigest', () => {
  it('parses the CLI double-encoded eval output', () => {
    expect(parseScrollInfo('"{\\"y\\":1200,\\"vh\\":800,\\"h\\":5400}"')).toEqual({
      y: 1200, viewportHeight: 800, pageHeight: 5400,
    })
  })

  it('parses plain JSON too', () => {
    expect(parseScrollInfo('{"y":0,"vh":800,"h":900}')).toEqual({ y: 0, viewportHeight: 800, pageHeight: 900 })
  })

  it('returns null on garbage', () => {
    expect(parseScrollInfo('✗ nope')).toBeNull()
    expect(parseScrollInfo('"{}"')).toBeNull()
  })

  it('formats viewport position with top/bottom markers', () => {
    expect(formatScrollDigest({ y: 1200, viewportHeight: 800, pageHeight: 5400 })).toContain('1200–2000 of 5400px')
    expect(formatScrollDigest({ y: 0, viewportHeight: 800, pageHeight: 5400 })).toContain('(top of page)')
    expect(formatScrollDigest({ y: 4600, viewportHeight: 800, pageHeight: 5400 })).toContain('(bottom of page)')
    expect(formatScrollDigest(null)).toBe('')
  })
})
