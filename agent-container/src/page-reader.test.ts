import { describe, it, expect } from 'vitest'
import { capSection, formatUnreadFrames, outlineOf, parseReadResult, readerScript, sectionOf, tidyRead } from './page-reader'

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

  it('names the heading each of several matches sits under', () => {
    const doc = '## Drill A\n\n### Specifications\n\n18V\n\n## Drill B\n\n### Specifications\n\n20V'
    expect(sectionOf(doc, 'specifications')).toBe('(under "Drill A")\n### Specifications\n\n18V\n\n(under "Drill B")\n### Specifications\n\n20V')
  })

  it('does not repeat a nested match inside a section already returned', () => {
    const doc = '## Shipping\n\ntext\n\n### Shipping rates\n\nrates\n\n## Returns'
    expect(sectionOf(doc, 'shipping')).toBe('## Shipping\n\ntext\n\n### Shipping rates\n\nrates')
  })
})

describe('capSection', () => {
  it('returns a short section whole, and a long one as its start plus its sub-headings', () => {
    expect(capSection('## A\n\nshort')).toBe('## A\n\nshort')
    const long = `# Hotel\n\n${'x'.repeat(5000)}\n\n## Prices\n\n${'p'.repeat(2000)}\n\n## Reviews\n\nr`
    const capped = capSection(long)
    expect(capped.length).toBeLessThan(6000 + 300)
    expect(capped).toMatch(/…\[this section continues for \d+ more chars; its sub-headings \(pass one as section to read just it\):\n {2}- Prices\n {2}- Reviews\]$/)
  })
})

describe('tidyRead', () => {
  it('joins a list marker left alone on its line with the text it introduces', () => {
    expect(tidyRead('-\n\nPlatform\n\n- Pricing\n-\n\n- Nested')).toBe('- Platform\n\n- Pricing\n\n- Nested')
    expect(tidyRead('  -\n  Solutions')).toBe('  - Solutions')
    // Carousel dots and other glyph-only lines are dropped (Craigslist: 799 of 1,689 lines).
    expect(tidyRead('Bike\n•\n• •\n$120\n·')).toBe('Bike\n$120')
  })

  it('makes adjacent code blocks one block, and leaves code lines alone', () => {
    expect(tidyRead('Code:\n\n```\nconst a = 1\n```\n\n```\n  -\n```\n\n```\n•\n```\n\nafter')).toBe('Code:\n\n```\nconst a = 1\n  -\n•\n```\n\nafter')
  })
})

describe('formatUnreadFrames', () => {
  it('names the frames the read did not enter, largest first, with how much of the viewport each covers', () => {
    expect(formatUnreadFrames([
      { name: '', host: 'ads.example.net', cover: 0.04 },
      { name: 'Human verification challenge', host: 'captcha.px-cdn.net', cover: 1 },
      { name: 'hidden', host: 'x.com', cover: 0 },
    ])).toBe('\n\nIframes on the page, not included above (browser_snapshot reads into them): "Human verification challenge" (captcha.px-cdn.net) · covers 100% of the viewport; unnamed (ads.example.net) · covers 4% of the viewport')
    expect(formatUnreadFrames([])).toBe('')
    expect(formatUnreadFrames([{ name: 'tiny', host: '', cover: 0.001 }])).toBe('\n\nIframes on the page, not included above (browser_snapshot reads into them): "tiny" · covers <1% of the viewport')
  })
})

describe('parseReadResult / readerScript', () => {
  it('parses the CLI\'s double-encoded output', () => {
    expect(parseReadResult(JSON.stringify(JSON.stringify({ text: '# Hi', truncated: false })))).toEqual({ text: '# Hi', truncated: false, frames: [] })
    expect(parseReadResult('{"text":"x","truncated":true,"frames":[{"name":"F","host":"h","cover":0.5}]}')).toEqual({ text: 'x', truncated: true, frames: [{ name: 'F', host: 'h', cover: 0.5 }] })
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
