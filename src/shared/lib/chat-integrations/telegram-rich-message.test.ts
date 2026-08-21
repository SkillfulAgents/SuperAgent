import { describe, it, expect } from 'vitest'
import { telegramConfigSchema } from './config-schema'
import {
  markdownToRichMessage,
  splitForRichLimits,
  RICH_MAX_LENGTH,
  escapeMarkdown,
  codeSpan,
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
