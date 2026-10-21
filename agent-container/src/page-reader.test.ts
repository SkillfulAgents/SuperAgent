import { describe, it, expect } from 'vitest'
import { outlineOf, parseReadResult, readerScript, sectionOf, tidyRead } from './page-reader'

const DOC = `# Trail runner

Price: $120.00

## Search

City

## Options

### Sizes

- Size 8
- Size 9

## Checkout

Email Place order

\`\`\`
# not a heading
\`\`\``

describe('outlineOf', () => {
  it('lists headings by level and skips fenced code', () => {
    expect(outlineOf(DOC)).toBe('- Trail runner\n  - Search\n  - Options\n    - Sizes\n  - Checkout')
    expect(outlineOf('no headings here')).toBe('')
  })
})

describe('sectionOf', () => {
  it('returns each matching section up to the next heading of the same or a higher level', () => {
    expect(sectionOf(DOC, 'options')).toBe('## Options\n\n### Sizes\n\n- Size 8\n- Size 9')
    expect(sectionOf(DOC, 'SIZES')).toBe('### Sizes\n\n- Size 8\n- Size 9')
    expect(sectionOf(DOC, 'checkout')).toBe('## Checkout\n\nEmail Place order\n\n```\n# not a heading\n```')
    expect(sectionOf(DOC, 'nothing like it')).toBe('')
    expect(sectionOf(DOC, '  ')).toBe('')
  })

  it('prefers headings that are exactly the text over ones that merely contain it', () => {
    const doc = '### Aftermath of World War I\n\nearlier\n\n## Aftermath\n\nlater\n\n## Impact'
    expect(sectionOf(doc, 'aftermath')).toBe('## Aftermath\n\nlater')
    expect(sectionOf(doc, 'after')).toBe('### Aftermath of World War I\n\nearlier\n\n## Aftermath\n\nlater')
  })

  it('does not repeat a nested match inside a section already returned', () => {
    const doc = '## Shipping\n\ntext\n\n### Shipping rates\n\nrates\n\n## Returns'
    expect(sectionOf(doc, 'shipping')).toBe('## Shipping\n\ntext\n\n### Shipping rates\n\nrates')
  })
})

describe('tidyRead', () => {
  it('joins a list marker left alone on its line with the text it introduces', () => {
    expect(tidyRead('-\n\nPlatform\n\n- Pricing\n-\n\n- Nested')).toBe('- Platform\n\n- Pricing\n\n- Nested')
    expect(tidyRead('  -\n  Solutions')).toBe('  - Solutions')
  })
})

describe('parseReadResult / readerScript', () => {
  it('parses the CLI\'s double-encoded output', () => {
    expect(parseReadResult(JSON.stringify(JSON.stringify({ text: '# Hi', truncated: false })))).toEqual({ text: '# Hi', truncated: false })
    expect(parseReadResult('{"text":"x","truncated":true}')).toEqual({ text: 'x', truncated: true })
    expect(parseReadResult('✗ Browser not launched')).toBeNull()
    expect(parseReadResult('{"nope":1}')).toBeNull()
  })

  it('is one self-contained IIFE that returns JSON', () => {
    const s = readerScript()
    expect(s.startsWith('(function(){')).toBe(true)
    expect(s.endsWith('})()')).toBe(true)
    // eslint-disable-next-line no-new-func
    expect(() => new Function(`return ${s}`)).not.toThrow()
  })
})
