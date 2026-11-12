import { describe, it, expect } from 'vitest'
import { telegramConfigSchema } from './config-schema'
import {
  markdownToRichMessage,
  splitForRichLimits,
  RICH_MAX_LENGTH,
  escapeMarkdown,
  codeSpan,
  keepLiteral,
} from './telegram-rich-message'

describe('markdownToRichMessage', () => {
  it('passes GFM markdown through untouched in the markdown field', () => {
    const md = '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |'
    expect(markdownToRichMessage(md)).toEqual({ markdown: md })
  })

  it('omits skip_entity_detection by default (auto-detection ON)', () => {
    expect(markdownToRichMessage('hi').skip_entity_detection).toBeUndefined()
  })

  it('sets skip_entity_detection when requested', () => {
    expect(markdownToRichMessage('hi', { skipEntityDetection: true }).skip_entity_detection).toBe(true)
  })
})

describe('keepLiteral', () => {
  const unchanged = (md: string) => expect(keepLiteral(md)).toBe(md)

  it('fixes the three shapes Telegram breaks: prices, unknown tags and code-like == or ||', () => {
    const cases: Array<[string, string]> = [
      ['An 18% tip on $600 is **$108**, total **$708**.', 'An 18% tip on \\$600 is **\\$108**, total **\\$708**.'],
      ['Ticker $AAPL closed at $150, set $HOME, it costs $5 and $6', 'Ticker $AAPL closed at \\$150, set $HOME, it costs \\$5 and \\$6'],
      ['Pass <your-token> or <API_KEY>, not <tg-token>.', 'Pass &lt;your-token> or &lt;API_KEY>, not &lt;tg-token>.'],
      ['Set $API_KEY to <your-key> and $SECRET to <your-secret>.', 'Set $API_KEY to &lt;your-key> and $SECRET to &lt;your-secret>.'],
      ['a==b and c==d, x||y and z||w', 'a\\=\\=b and c\\=\\=d, x\\|\\|y and z\\|\\|w'],
      ['Use $HOME when a==b, else $PATH', 'Use $HOME when a\\=\\=b, else $PATH'],
      ['C:\\\\$5 and C:\\\\<your-token>', 'C:\\\\\\$5 and C:\\\\&lt;your-token>'],
    ]
    for (const [md, sent] of cases) expect(keepLiteral(md)).toBe(sent)
    for (const md of ['', '   ', '$', '<', '<>', 'Already \\$5. a < b, x<y', '\\<name>']) unchanged(md)
  })

  it('leaves the formatting Telegram renders: formulas, highlights, spoilers, its tags and table cells', () => {
    for (const md of [
      '$$E = mc^2$$ and $x^2$, $x==y$ and $x<y>z$, $$5 + 3 = 8$$',
      'this is ==very important==, the pin is ||1234||',
      'An <u>underlined</u> word, a<br/>break, <tg-spoiler>x</tg-spoiler>',
      '<a title="1 > 0" href="https://a.com/$5">pay</a>',
      '|a|b|c|\n|-|-|-|\n|x||y|',
    ]) unchanged(md)
    expect(keepLiteral('<details>\n<summary>Cost</summary>\n$600 is **$108**; <your-token>\n</details>'))
      .toBe('<details>\n<summary>Cost</summary>\n\\$600 is **\\$108**; &lt;your-token>\n</details>')
    expect(keepLiteral('|a|b|c|\n|-|-|-|\n|$1 $2 $3 $4 $5||y|')).toBe('|a|b|c|\n|-|-|-|\n|\\$1 \\$2 \\$3 \\$4 \\$5||y|')
  })

  it('never touches code, wherever it sits', () => {
    const code = '$5 <your-token> a==b'
    for (const md of [
      `Run \`${code}\`, then:\n\n\`\`\`sh\n${code}\n\`\`\``,
      `1. Run:\n   \`\`\`bash\n   ${code}\n   \`\`\`\n\n> \`\`\`sh\n> ${code}\n> \`\`\``,
      `- \`\`\`sh\n  ${code}\n  \`\`\``,
      `\`\`\`\`\n${code}\n\`\`\`\`\`\``,
      `- ~~~sh\n  first\n\n  ${code}\n  ~~~`,
      `    ${code}`,
      `- use \`echo\n  $5\` here`,
      `C:\\\\\`${code}\``,
      '```sh\necho $A',
    ]) unchanged(md)
    expect(keepLiteral(`| var | cost |\n|---|---|\n| \`${code}\` | $5 |`)).toBe(`| var | cost |\n|---|---|\n| \`${code}\` | \\$5 |`)
    expect(keepLiteral('`$x` then $x<y>$ and `$x` <your-token> costs $5')).toBe('`$x` then $x<y>$ and `$x` &lt;your-token> costs \\$5')
    expect(keepLiteral('a ` b $5\n\nc $6 ` d')).toBe('a ` b \\$5\n\nc \\$6 ` d')
    expect(keepLiteral(escapeMarkdown('`$600 is $108 <your-token>`'))).toBe('\\`\\$600 is \\$108 &lt;your-token>\\`')
    unchanged(codeSpan('a$5`b'))
    const fence = '```py\n' + 'x = a[b[c]] * d_e * f_g\n'.repeat(200) + '```'
    expect(keepLiteral(`Total is $600, tip $108.\n\n${fence}`)).toBe(`Total is \\$600, tip \\$108.\n\n${fence}`)
  })

  it('never touches where a link points, and escapes its label', () => {
    for (const md of [
      '[read](<report>), <https://a.com/$x>, <me@a.co>, https://a.com/?x=$5',
      '[x]( https://a.com/$5) and [x](https://a.com/a(b)?c=$5)',
      '[pay $5] and [pay $5][]\n\n[pay $5]: https://a.com',
      '[pay $5]\n\n[pay $5]:\n  /u',
      '[ref]: https://a.com/$9',
    ]) unchanged(md)
    expect(keepLiteral('[pay $5](https://a.com/?a=$1&b=$2)')).toBe('[pay \\$5](https://a.com/?a=$1&b=$2)')
    expect(keepLiteral('[pay $5][r] and [$6][r]\n\n[r]: https://a.com')).toBe('[pay \\$5][r] and [\\$6][r]\n\n[r]: https://a.com')
    expect(keepLiteral('| get | cost |\n|---|---|\n| [x](https://a.com/?a=$1) | $5 |')).toBe('| get | cost |\n|---|---|\n| [x](https://a.com/?a=$1) | \\$5 |')
    expect(keepLiteral('[Alice]: It costs $600 and $700')).toBe('[Alice]: It costs \\$600 and \\$700')
    expect(keepLiteral('[^1]: Was $5, now $6.')).toBe('[^1]: Was \\$5, now \\$6.')
    expect(keepLiteral(escapeMarkdown('[x](<your-token>)'))).toBe('\\[x\\](&lt;your-token>)')
  })

  it('sends a reply that would stall the parser as written', () => {
    for (const md of [
      '$5 ' + '['.repeat(6000) + 'a' + '](u)'.repeat(6000),
      '$5 ' + '[a'.repeat(3000),
      '$5 ' + '**['.repeat(8000),
      '- '.repeat(3000) + '$5 $6',
      '1. '.repeat(3000) + '$5 $6',
    ]) unchanged(md)
  })
})

describe('escapeMarkdown', () => {
  it('escapes the inline-formatting metacharacters', () => {
    expect(escapeMarkdown('a*b_c~d`e[f]g\\h')).toBe('a\\*b\\_c\\~d\\`e\\[f\\]g\\\\h')
  })

  it('leaves block-level punctuation untouched', () => {
    expect(escapeMarkdown('v0.3 (build #4) - done.')).toBe('v0.3 (build #4) - done.')
  })

  it('neutralizes a value that would otherwise format', () => {
    // `**KEY**` would render bold; escaped, the asterisks stay literal.
    expect(escapeMarkdown('**KEY**')).toBe('\\*\\*KEY\\*\\*')
  })
})

describe('codeSpan', () => {
  it('wraps a plain value in single backticks', () => {
    expect(codeSpan('/tmp/file.txt')).toBe('`/tmp/file.txt`')
  })

  it('uses a longer fence when the value contains a backtick', () => {
    // A single internal backtick can no longer close the span.
    expect(codeSpan('weird`name')).toBe('``weird`name``')
  })

  it('pads when the value starts or ends with a backtick', () => {
    expect(codeSpan('`leading')).toBe('`` `leading ``')
  })
})

describe('splitForRichLimits', () => {
  it('returns a single chunk when under the limit', () => {
    expect(splitForRichLimits('short')).toEqual(['short'])
  })

  it('splits a body over the 32768 ceiling', () => {
    const big = 'para\n\n'.repeat(7000) // > 32768 chars
    const chunks = splitForRichLimits(big)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= RICH_MAX_LENGTH)).toBe(true)
  })

  it('keeps each chunk under the ceiling after escaping, even for a body of nothing but dollars', () => {
    for (const md of ['$1 '.repeat(11000), '$'.repeat(40000)]) {
      const chunks = splitForRichLimits(md)
      expect(chunks.length).toBeGreaterThan(1)
      for (const chunk of chunks) expect(keepLiteral(chunk).length).toBeLessThanOrEqual(RICH_MAX_LENGTH)
    }
  })
})

describe('telegramConfigSchema rich flags', () => {
  it('accepts the rich flags', () => {
    const r = telegramConfigSchema.parse({
      botToken: 't',
      richMessages: false,
      draftStreaming: false,
      skipEntityDetection: true,
    })
    expect(r.richMessages).toBe(false)
    expect(r.draftStreaming).toBe(false)
    expect(r.skipEntityDetection).toBe(true)
  })

  it('leaves the flags undefined when omitted (defaults applied in connector)', () => {
    const r = telegramConfigSchema.parse({ botToken: 't' })
    expect(r.richMessages).toBeUndefined()
  })
})

// Representative real agent briefs. Add more from actual sessions over time.
const GOLDEN_BRIEFS = [
  '# Benchmark results\n\nI benchmarked the eviction policies. **LRU wins** on hit-rate.\n\n| Policy | Hit rate | p99 |\n|--------|----------|-----|\n| LRU | 94% | 12ms |\n| FIFO | 88% | 9ms |\n\nMemory overhead is ~O(n).\n\n```python\ncache = LRUCache(maxsize=1000)\n```',
  '## Next steps\n\n- Add metrics\n- Benchmark under load\n- [ ] Open PR\n- [x] Write tests\n\n> Note: clock skew ruled out TTL eviction.',
  'Mixed: `inline code`, **bold _nested italic_ bold**, ~~strike~~, a [link](https://example.com), and ==highlight==.',
]

describe('golden corpus: real agent briefs', () => {
  it('converts every brief without throwing', () => {
    for (const md of GOLDEN_BRIEFS) {
      expect(() => markdownToRichMessage(md)).not.toThrow()
      expect(markdownToRichMessage(md).markdown).toBe(md)
    }
  })

  it('keeps each chunk within the rich ceiling', () => {
    for (const md of GOLDEN_BRIEFS) {
      for (const chunk of splitForRichLimits(md)) {
        expect(chunk.length).toBeLessThanOrEqual(RICH_MAX_LENGTH)
      }
    }
  })
})
