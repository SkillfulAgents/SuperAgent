import { describe, it, expect } from 'vitest'
import { splitStreamingMarkdown } from './split-streaming-markdown'

// True if `block` contains an unterminated fenced code block (odd/open fence).
// Settled blocks must NEVER satisfy this — that's the whole point of being
// fence-aware.
function hasOpenFence(block: string): boolean {
  const lines = block.split('\n')
  let open: { char: string; len: number } | null = null
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (!open) {
      if (m) open = { char: m[1][0], len: m[1].length }
    } else if (
      m &&
      m[1][0] === open.char &&
      m[1].length >= open.len &&
      /^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(line)
    ) {
      open = null
    }
  }
  return open !== null
}

describe('splitStreamingMarkdown', () => {
  it('returns empty for empty input', () => {
    expect(splitStreamingMarkdown('')).toEqual({ settled: [], tail: '' })
  })

  it('keeps a single in-progress paragraph entirely in the tail', () => {
    const { settled, tail } = splitStreamingMarkdown('hello wor')
    expect(settled).toEqual([])
    expect(tail).toBe('hello wor')
  })

  it('settles earlier paragraphs and leaves the last as the tail', () => {
    const { settled, tail } = splitStreamingMarkdown('para one\n\npara two')
    expect(settled).toEqual(['para one'])
    expect(tail).toBe('para two')
  })

  it('keeps the last non-empty block as the tail even when a blank line follows', () => {
    // The final block stays in the tail (re-parsing it per delta is cheap) so we
    // never prematurely commit a block whose siblings — e.g. a loose-list
    // continuation — might still stream in. Trailing blanks add no empty blocks.
    const { settled, tail } = splitStreamingMarkdown('para one\n\npara two\n\n')
    expect(settled).toEqual(['para one'])
    expect(tail).toBe('para two')
  })

  it('collapses multiple blank lines into one boundary', () => {
    const { settled, tail } = splitStreamingMarkdown('a\n\n\n\nb')
    expect(settled).toEqual(['a'])
    expect(tail).toBe('b')
  })

  it('does NOT split inside an open fenced code block with internal blanks', () => {
    const text = '```python\ndef f():\n\n    return 1'
    const { settled, tail } = splitStreamingMarkdown(text)
    expect(settled).toEqual([])
    expect(tail).toBe(text)
    expect(hasOpenFence(tail)).toBe(true)
  })

  it('keeps an in-progress fence in the tail even when a paragraph precedes it', () => {
    const text = 'intro paragraph\n\n```ts\nconst x = 1\n\nconst y = 2'
    const { settled, tail } = splitStreamingMarkdown(text)
    expect(settled).toEqual(['intro paragraph'])
    expect(tail).toBe('```ts\nconst x = 1\n\nconst y = 2')
  })

  it('settles a completed fenced block (with internal blank) once a blank follows', () => {
    const fenced = '```python\ndef f():\n\n    return 1\n```'
    const { settled, tail } = splitStreamingMarkdown(`${fenced}\n\nnext`)
    expect(settled).toEqual([fenced])
    expect(tail).toBe('next')
    expect(hasOpenFence(settled[0])).toBe(false)
  })

  it('supports tilde fences', () => {
    const text = '~~~\nplain\n\ncode\n~~~\n\nafter'
    const { settled, tail } = splitStreamingMarkdown(text)
    expect(settled).toEqual(['~~~\nplain\n\ncode\n~~~'])
    expect(tail).toBe('after')
  })

  it('does not close a longer opening fence with a shorter delimiter', () => {
    // Opened with 4 backticks; a 3-backtick line is content, not a close.
    const text = '````\n```\nstill inside\n\nmore'
    const { settled, tail } = splitStreamingMarkdown(text)
    expect(settled).toEqual([])
    expect(hasOpenFence(tail)).toBe(true)
  })

  it('does not treat a fence-with-info-string as a closing fence', () => {
    const text = '```\ncode\n```js\nstill inside\n\nmore'
    const { settled, tail } = splitStreamingMarkdown(text)
    // The ```js line has an info string, so it cannot close the block.
    expect(settled).toEqual([])
    expect(hasOpenFence(tail)).toBe(true)
  })

  it('preserves all non-blank lines in order across settled + tail', () => {
    const text = 'a\n\nb\n\n```\nc\n\nd\n```\n\ne'
    const { settled, tail } = splitStreamingMarkdown(text)
    const recombined = [...settled, tail].join('\n')
    const nonBlank = (s: string) => s.split('\n').filter((l) => l.trim() !== '')
    expect(nonBlank(recombined)).toEqual(nonBlank(text))
  })

  // The core safety guarantee: for EVERY prefix of a streaming response, no
  // block we declare "settled" may contain an unterminated fence.
  it('never settles an unterminated fence at any streaming prefix', () => {
    const doc = [
      '# Heading',
      '',
      'Some intro text that explains the code below.',
      '',
      '```python',
      'def compute(n):',
      '',
      '    # a blank line lives inside this fence',
      '    return n * 2',
      '```',
      '',
      'A short paragraph between two code blocks.',
      '',
      '| col a | col b |',
      '| ----- | ----- |',
      '| 1     | 2     |',
      '',
      '```',
      'plain fence',
      '```',
      '',
      'Final words.',
    ].join('\n')

    for (let i = 1; i <= doc.length; i++) {
      const prefix = doc.slice(0, i)
      const { settled } = splitStreamingMarkdown(prefix)
      for (const block of settled) {
        expect(hasOpenFence(block), `prefix len ${i} settled an open fence: ${JSON.stringify(block)}`).toBe(false)
      }
    }
  })

  it('does NOT protect a 4-space-indented fence (documented CommonMark-indent limitation)', () => {
    // Per CommonMark a fence opener may be indented at most 3 spaces; at 4+ it is an
    // indented code block, not a fence. The splitter (and hasOpenFence) intentionally
    // share that rule via the /^ {0,3}.../ FENCE_LINE regex. So a 4-space-indented
    // fence (e.g. one nested in a list item) with an internal blank line WILL split
    // mid-stream — a known, transient artifact that self-heals when the message
    // persists and renders as a single document. This test pins that behavior so the
    // blind spot is an explicit, reviewed choice rather than a silent surprise.
    const text = '    ```js\n    const a = 1\n\n    const b = 2'
    const { settled, tail } = splitStreamingMarkdown(text)
    expect(settled).toEqual(['    ```js\n    const a = 1'])
    expect(tail).toBe('    const b = 2')
    // The 4-space marker is not recognized as a fence, so hasOpenFence agrees.
    expect(hasOpenFence(settled[0])).toBe(false)
  })

  it('settled blocks are monotonic: a settled block stays settled as text grows', () => {
    const doc = 'alpha\n\nbravo\n\ncharlie\n\ndelta'
    let prevSettled: string[] = []
    for (let i = 1; i <= doc.length; i++) {
      const { settled } = splitStreamingMarkdown(doc.slice(0, i))
      // every previously-settled block is still present, unchanged, as a prefix
      for (let k = 0; k < prevSettled.length; k++) {
        expect(settled[k]).toBe(prevSettled[k])
      }
      prevSettled = settled
    }
  })
})
