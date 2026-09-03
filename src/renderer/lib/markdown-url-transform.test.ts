import { describe, it, expect } from 'vitest'
import { createMarkdownUrlTransform, markdownUrlTransform } from './markdown-url-transform'

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

  it('rewrites a workspace file: link only on chat and preview transforms', () => {
    expect(onHref('file:///workspace/output/report.md')).toBe('')
    expect(onHref('FILE:///workspace/output/report.md')).toBe('')
    const chat = createMarkdownUrlTransform({ agentSlug: 'agent-1' })
    expect(chat('file:///workspace/output/report.md', 'href', node)).toBe(
      '/workspace/output/report.md',
    )
    expect(chat('FILE:///workspace/output/report.md', 'href', node)).toBe(
      '/workspace/output/report.md',
    )
    const preview = createMarkdownUrlTransform({ baseFilePath: '/workspace/output/notes.md' })
    expect(preview('file:///workspace/output/report.md', 'href', node)).toBe(
      '/workspace/output/report.md',
    )
  })

  it('still blanks dangerous / unknown schemes exactly as the default does', () => {
    expect(onHref('javascript:alert(1)')).toBe('')
    expect(onHref('file:///etc/passwd')).toBe('')
    expect(onHref('file:///workspace/../secret.md')).toBe('')
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

  it('resolves only exact tool-verified file image aliases', () => {
    const transform = createMarkdownUrlTransform({
      aliases: new Map([
        ['file:///home/claude/screenshot.png', '/api/agents/a/sessions/s/media/ref'],
      ]),
    })

    expect(transform('file:///home/claude/screenshot.png', 'src', node)).toBe(
      '/api/agents/a/sessions/s/media/ref'
    )
    expect(transform('file:///home/claude/secret.png', 'src', node)).toBe('')
    expect(transform('file:///home/claude/screenshot.png', 'href', node)).toBe('')
  })

  it('routes workspace images through the authenticated file endpoint', () => {
    const transform = createMarkdownUrlTransform({ agentSlug: 'my agent' })
    expect(transform('file:///workspace/reports/chart 1.png', 'src', node)).toBe(
      '/api/agents/my%20agent/files/reports/chart%201.png?inline=true'
    )
  })

  it('resolves a relative href only when a preview base file is set', () => {
    const preview = createMarkdownUrlTransform({ baseFilePath: '/workspace/output/report.md' })
    expect(preview('notes.md', 'href', node)).toBe('/workspace/output/notes.md')
    expect(onHref('notes.md')).toBe('notes.md')
  })

  it('routes a relative preview image through the authenticated file endpoint', () => {
    const preview = createMarkdownUrlTransform({
      agentSlug: 'agent-1',
      baseFilePath: '/workspace/output/report.md',
    })
    expect(preview('chart.png', 'src', node)).toBe(
      '/api/agents/agent-1/files/output/chart.png?inline=true',
    )
    expect(preview('../hero.png', 'src', node)).toBe(
      '/api/agents/agent-1/files/hero.png?inline=true',
    )
    expect(preview('../../secret.png', 'src', node)).toBe('../../secret.png')
    const chat = createMarkdownUrlTransform({ agentSlug: 'agent-1' })
    expect(chat('chart.png', 'src', node)).toBe('chart.png')
  })

  it('does not widen traversals, non-images, or file URLs outside the workspace', () => {
    const transform = createMarkdownUrlTransform({ agentSlug: 'a' })
    expect(transform('file:///workspace/../secrets.png', 'src', node)).toBe('')
    expect(transform('file:///workspace/report.txt', 'src', node)).toBe('')
    expect(transform('file:///etc/passwd.png', 'src', node)).toBe('')
  })
})
