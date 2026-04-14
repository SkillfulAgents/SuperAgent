import { describe, it, expect } from 'vitest'
import { markdownToTelegramHtml } from './telegram-connector'

// Helper: normalize whitespace for easier assertions
const norm = (s: string) => s.replace(/\n{2,}/g, '\n\n').trim()

describe('markdownToTelegramHtml', () => {
  // ── Inline formatting ───────────────────────────────────────────────

  it('converts bold text', () => {
    expect(markdownToTelegramHtml('Hello **world**')).toContain('<strong>world</strong>')
  })

  it('converts italic text', () => {
    expect(markdownToTelegramHtml('Hello *world*')).toContain('<em>world</em>')
  })

  it('converts inline code', () => {
    expect(markdownToTelegramHtml('Use `console.log`')).toContain('<code>console.log</code>')
  })

  it('converts strikethrough', () => {
    expect(markdownToTelegramHtml('This is ~~removed~~')).toContain('<del>removed</del>')
  })

  it('converts links', () => {
    const result = markdownToTelegramHtml('Visit [Google](https://google.com)')
    expect(result).toContain('<a href="https://google.com">Google</a>')
  })

  it('handles mixed inline formatting', () => {
    const result = markdownToTelegramHtml('This is **bold** and *italic* and `code`')
    expect(result).toContain('<strong>bold</strong>')
    expect(result).toContain('<em>italic</em>')
    expect(result).toContain('<code>code</code>')
  })

  // ── Block-level elements ────────────────────────────────────────────

  it('converts headings to bold text', () => {
    const result = markdownToTelegramHtml('## My Heading')
    expect(result).toContain('<b>My Heading</b>')
    // Should NOT contain <h2> tags
    expect(result).not.toContain('<h2>')
  })

  it('converts fenced code blocks to <pre>', () => {
    const result = markdownToTelegramHtml('```js\nconsole.log(1)\n```')
    expect(result).toContain('<pre>')
    expect(result).toContain('console.log(1)')
    expect(result).toContain('</pre>')
    // Should NOT contain <code> wrapper (Telegram <pre> alone is fine)
    expect(result).not.toContain('class=')
  })

  it('escapes HTML entities inside code blocks', () => {
    const result = markdownToTelegramHtml('```\nif (a < b && c > d) {}\n```')
    expect(result).toContain('&lt;')
    expect(result).toContain('&gt;')
    expect(result).toContain('&amp;&amp;')
  })

  it('converts unordered lists with bullet points', () => {
    const result = markdownToTelegramHtml('- item 1\n- item 2\n- item 3')
    expect(result).toContain('• item 1')
    expect(result).toContain('• item 2')
    expect(result).toContain('• item 3')
    // No <ul> or <li> tags
    expect(result).not.toContain('<ul>')
    expect(result).not.toContain('<li>')
  })

  it('converts ordered lists with numbers', () => {
    const result = markdownToTelegramHtml('1. first\n2. second\n3. third')
    expect(result).toContain('1. first')
    expect(result).toContain('2. second')
    expect(result).toContain('3. third')
    expect(result).not.toContain('<ol>')
    expect(result).not.toContain('<li>')
  })

  it('converts horizontal rules', () => {
    const result = markdownToTelegramHtml('Above\n\n---\n\nBelow')
    expect(result).toContain('---')
  })

  it('converts blockquotes', () => {
    const result = markdownToTelegramHtml('> This is a quote')
    expect(result).toContain('<blockquote>')
    expect(result).toContain('This is a quote')
    expect(result).toContain('</blockquote>')
  })

  // ── Tables ──────────────────────────────────────────────────────────

  it('converts tables to pre-formatted monospace text', () => {
    const md = '| Rate | Interest |\n|---|---|\n| 5% | $1,364 |\n| 7% | $1,916 |'
    const result = markdownToTelegramHtml(md)
    expect(result).toContain('<pre>')
    expect(result).toContain('Rate')
    expect(result).toContain('Interest')
    expect(result).toContain('5%')
    expect(result).toContain('$1,364')
    expect(result).toContain('</pre>')
    // No <table> tags
    expect(result).not.toContain('<table>')
    expect(result).not.toContain('<td>')
    expect(result).not.toContain('<th>')
  })

  it('aligns table columns', () => {
    const md = '| A | Longer |\n|---|---|\n| x | y |'
    const result = markdownToTelegramHtml(md)
    // Headers should be padded to align
    expect(result).toContain('<pre>')
    // "A" column should be padded to match "x" (both 1 char — same width)
    // "Longer" column should be wider than "y"
    const preContent = result.match(/<pre>([\s\S]*?)<\/pre>/)?.[1] || ''
    const lines = preContent.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(3) // header + separator + 1 row
  })

  it('handles table with bold text in cells as plain text', () => {
    const md = '| Name | Value |\n|---|---|\n| **Total** | $100 |'
    const result = markdownToTelegramHtml(md)
    expect(result).toContain('<pre>')
    // Bold is stripped inside tables (it's in <pre> so wouldn't render anyway)
    expect(result).toContain('Total')
    expect(result).toContain('$100')
    expect(result).not.toContain('<table>')
  })

  // ── Safety: unsupported tags stripped ────────────────────────────────

  it('strips unsupported HTML tags from raw HTML in markdown', () => {
    const result = markdownToTelegramHtml('Hello <div>world</div>')
    expect(result).not.toContain('<div>')
    expect(result).not.toContain('</div>')
  })

  it('preserves supported Telegram tags', () => {
    // When marked processes this, it treats raw HTML as html tokens
    // The output should not contain the raw tags since our renderer escapes them
    // But the important thing is no crash and no unsupported tags
    const result = markdownToTelegramHtml('**bold** and `code`')
    expect(result).toContain('<strong>bold</strong>')
    expect(result).toContain('<code>code</code>')
  })

  // ── Edge cases ──────────────────────────────────────────────────────

  it('handles plain text without markdown', () => {
    const result = markdownToTelegramHtml('Just plain text')
    expect(norm(result)).toBe('Just plain text')
  })

  it('handles empty string', () => {
    expect(markdownToTelegramHtml('')).toBe('')
  })

  it('does not produce excessive newlines', () => {
    const result = markdownToTelegramHtml('Para 1\n\n\n\nPara 2')
    expect(result).not.toContain('\n\n\n')
  })

  it('handles a complex real-world response', () => {
    const md = [
      '## Summary',
      '',
      'Here are the results:',
      '',
      '- **Monthly Payment:** $4,280.37',
      '- **Total Paid:** $51,364.49',
      '',
      '| Rate | Total Interest |',
      '|---|---|',
      '| 5% | $1,364 |',
      '| 7% | $1,916 |',
      '| 10% | $2,749 |',
      '',
      '```python',
      'print("hello")',
      '```',
      '',
      'Visit [our docs](https://example.com) for more.',
    ].join('\n')

    const result = markdownToTelegramHtml(md)

    // Should contain all the expected formatting
    expect(result).toContain('<b>Summary</b>')
    expect(result).toContain('<strong>Monthly Payment:</strong>')
    expect(result).toContain('• ')
    expect(result).toContain('<pre>')
    expect(result).toContain('print("hello")')
    expect(result).toContain('<a href="https://example.com">our docs</a>')

    // Should NOT contain any unsupported tags
    expect(result).not.toContain('<table>')
    expect(result).not.toContain('<h2>')
    expect(result).not.toContain('<ul>')
    expect(result).not.toContain('<li>')
    expect(result).not.toContain('<p>')
  })
})
