import { describe, it, expect } from 'vitest'
import { markdownToSlackMrkdwn } from './slack-connector'

describe('markdownToSlackMrkdwn', () => {
  // ── Inline formatting ───────────────────────────────────────────────

  it('converts bold text (**text** → *text*)', () => {
    expect(markdownToSlackMrkdwn('Hello **world**')).toBe('Hello *world*')
  })

  it('converts __bold__ text', () => {
    expect(markdownToSlackMrkdwn('Hello __world__')).toBe('Hello *world*')
  })

  it('converts italic text (*text* → _text_)', () => {
    expect(markdownToSlackMrkdwn('Hello *world*')).toContain('_world_')
  })

  it('preserves inline code', () => {
    expect(markdownToSlackMrkdwn('Use `console.log`')).toContain('`console.log`')
  })

  it('converts strikethrough (~~text~~ → ~text~)', () => {
    expect(markdownToSlackMrkdwn('This is ~~removed~~')).toContain('~removed~')
    // Should NOT have double tildes
    expect(markdownToSlackMrkdwn('This is ~~removed~~')).not.toContain('~~')
  })

  it('converts links ([text](url) → <url|text>)', () => {
    const result = markdownToSlackMrkdwn('Visit [Google](https://google.com)')
    expect(result).toContain('<https://google.com|Google>')
  })

  it('handles mixed inline formatting', () => {
    const result = markdownToSlackMrkdwn('This is **bold** and `code`')
    expect(result).toContain('*bold*')
    expect(result).toContain('`code`')
  })

  // ── Block-level elements ────────────────────────────────────────────

  it('converts headings to bold text', () => {
    expect(markdownToSlackMrkdwn('## My Heading')).toContain('*My Heading*')
  })

  it('converts h1 through h6', () => {
    expect(markdownToSlackMrkdwn('# H1')).toContain('*H1*')
    expect(markdownToSlackMrkdwn('### H3')).toContain('*H3*')
    expect(markdownToSlackMrkdwn('###### H6')).toContain('*H6*')
  })

  it('converts fenced code blocks', () => {
    const result = markdownToSlackMrkdwn('```js\nconsole.log(1)\n```')
    expect(result).toContain('```')
    expect(result).toContain('console.log(1)')
  })

  it('strips language identifier from code blocks', () => {
    const result = markdownToSlackMrkdwn('```python\nprint("hi")\n```')
    expect(result).not.toContain('python')
    expect(result).toContain('print("hi")')
  })

  it('converts unordered lists with bullet points', () => {
    const result = markdownToSlackMrkdwn('- item 1\n- item 2\n- item 3')
    expect(result).toContain('• item 1')
    expect(result).toContain('• item 2')
    expect(result).toContain('• item 3')
  })

  it('converts * list markers to bullets', () => {
    const result = markdownToSlackMrkdwn('* item 1\n* item 2')
    expect(result).toContain('• item 1')
    expect(result).toContain('• item 2')
  })

  it('preserves ordered lists', () => {
    const result = markdownToSlackMrkdwn('1. first\n2. second\n3. third')
    expect(result).toContain('1. first')
    expect(result).toContain('2. second')
  })

  it('converts horizontal rules', () => {
    const result = markdownToSlackMrkdwn('Above\n\n---\n\nBelow')
    expect(result).toContain('───')
  })

  it('preserves blockquotes', () => {
    const result = markdownToSlackMrkdwn('> This is a quote')
    expect(result).toContain('> This is a quote')
  })

  // ── Tables ──────────────────────────────────────────────────────────

  it('converts tables to monospace code blocks', () => {
    const md = '| Name | Value |\n|---|---|\n| Alice | 100 |\n| Bob | 200 |'
    const result = markdownToSlackMrkdwn(md)
    expect(result).toContain('```')
    expect(result).toContain('Name')
    expect(result).toContain('Alice')
    expect(result).toContain('200')
  })

  it('filters out table separator rows', () => {
    const md = '| A | B |\n|---|---|\n| x | y |'
    const result = markdownToSlackMrkdwn(md)
    // The separator row (|---|---|) should not appear literally
    expect(result).not.toMatch(/\|---/)
  })

  // ── Edge cases ──────────────────────────────────────────────────────

  it('handles plain text without markdown', () => {
    expect(markdownToSlackMrkdwn('Just plain text')).toBe('Just plain text')
  })

  it('handles empty string', () => {
    expect(markdownToSlackMrkdwn('')).toBe('')
  })

  it('does not produce excessive newlines', () => {
    const result = markdownToSlackMrkdwn('Para 1\n\n\n\nPara 2')
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
      '',
      '```python',
      'print("hello")',
      '```',
      '',
      'Visit [our docs](https://example.com) for more.',
    ].join('\n')

    const result = markdownToSlackMrkdwn(md)

    // Should contain Slack formatting
    expect(result).toContain('*Summary*')           // heading → bold
    expect(result).toContain('*Monthly Payment:*')  // bold
    expect(result).toContain('• ')                   // bullet list
    expect(result).toContain('```')                  // code block
    expect(result).toContain('print("hello")')
    expect(result).toContain('<https://example.com|our docs>')  // link
  })
})
