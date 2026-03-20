import { describe, it, expect } from 'vitest'
import { rewriteTabNewCommand } from './browser-command-args'

describe('rewriteTabNewCommand', () => {
  it('rewrites tab new <url> to eval with window.open', () => {
    const result = rewriteTabNewCommand(['tab', 'new', 'https://example.com'])
    expect(result).toEqual([
      'eval',
      '(() => { window.open("https://example.com", \'_blank\'); return \'opened\'; })()',
    ])
  })

  it('uses about:blank as default when no url provided', () => {
    const result = rewriteTabNewCommand(['tab', 'new'])
    expect(result).toEqual([
      'eval',
      '(() => { window.open("about:blank", \'_blank\'); return \'opened\'; })()',
    ])
  })

  it('escapes special characters in url safely', () => {
    const result = rewriteTabNewCommand(['tab', 'new', "url'with\"quotes"])
    expect(result[0]).toBe('eval')
    // JSON.stringify handles all escaping — no breakout possible
    expect(result[1]).toContain('window.open("url\'with\\"quotes"')
  })

  it('handles backslash-quote sequences safely', () => {
    // This input would break the old single-quote escaping approach
    const result = rewriteTabNewCommand(['tab', 'new', "test\\'breakout"])
    expect(result[0]).toBe('eval')
    expect(result[1]).toContain('window.open("test\\\\\'breakout"')
  })

  it('passes non-tab commands through unchanged', () => {
    expect(rewriteTabNewCommand(['click', '@e1'])).toEqual(['click', '@e1'])
    expect(rewriteTabNewCommand(['tab', '2'])).toEqual(['tab', '2'])
    expect(rewriteTabNewCommand(['eval', 'document.title'])).toEqual(['eval', 'document.title'])
  })
})
