import { describe, it, expect } from 'vitest'
import { markdownUrlTransform } from './markdown-url-transform'

// react-markdown's UrlTransform is (url, key, node); node is unused here.
const node = {} as never
const onHref = (url: string) => markdownUrlTransform(url, 'href', node)
const onSrc = (url: string) => markdownUrlTransform(url, 'src', node)

describe('markdownUrlTransform (SUP-238)', () => {
  it('preserves the react-markdown default-safe link schemes', () => {
    expect(onHref('https://example.com/x?y=1#z')).toBe('https://example.com/x?y=1#z')
    expect(onHref('http://localhost:3000')).toBe('http://localhost:3000')
    expect(onHref('mailto:hello@example.com')).toBe('mailto:hello@example.com')
  })

  it('additionally preserves tel: and sms: (SUP-214 composer schemes)', () => {
    expect(onHref('tel:+15551234567')).toBe('tel:+15551234567')
    expect(onHref('sms:+15551234567')).toBe('sms:+15551234567')
    expect(onHref('sms:+15551234567?&body=hi')).toBe('sms:+15551234567?&body=hi')
  })

  it('matches the extra schemes case-insensitively', () => {
    expect(onHref('TEL:+15551234567')).toBe('TEL:+15551234567')
    expect(onHref('SmS:+15551234567')).toBe('SmS:+15551234567')
  })

  it('preserves relative / fragment / query links', () => {
    expect(onHref('/agents/foo')).toBe('/agents/foo')
    expect(onHref('./sibling')).toBe('./sibling')
    expect(onHref('../up')).toBe('../up')
    expect(onHref('#section')).toBe('#section')
    expect(onHref('?q=1')).toBe('?q=1')
  })

  it('still blanks dangerous / unknown schemes exactly as the default does', () => {
    expect(onHref('javascript:alert(1)')).toBe('')
    expect(onHref('file:///etc/passwd')).toBe('')
    expect(onHref('data:text/html,<script>alert(1)</script>')).toBe('')
    expect(onHref('vbscript:msgbox(1)')).toBe('')
    expect(onHref('myapp://do-something')).toBe('')
  })

  it('only widens link hrefs, not other URL properties (e.g. img src)', () => {
    // The tel:/sms: allowance is scoped to key === 'href'; for an image src the
    // default behavior (blank) still applies.
    expect(onSrc('tel:+15551234567')).toBe('')
    expect(onSrc('sms:+15551234567')).toBe('')
    // …while genuinely safe src schemes still pass through the default.
    expect(onSrc('https://example.com/a.png')).toBe('https://example.com/a.png')
  })
})
