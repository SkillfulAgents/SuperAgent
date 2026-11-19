import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { rehypeStreamingWordReveal } from './streaming-word-reveal'

interface TestNode {
  type?: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: TestNode[]
  position?: { start?: { offset?: number } }
}

function paragraph(children: TestNode[]): TestNode {
  return {
    type: 'root',
    children: [{ type: 'element', tagName: 'p', children }],
  }
}

function spansOf(tree: TestNode): TestNode[] {
  const found: TestNode[] = []
  const visit = (node: TestNode) => {
    if (node.tagName === 'span') found.push(node)
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return found
}

describe('rehypeStreamingWordReveal', () => {
  it('wraps sourced words and staggers their delays', () => {
    const tree = paragraph([
      { type: 'text', value: 'two words', position: { start: { offset: 0 } } },
    ])

    rehypeStreamingWordReveal({ batchStarts: [0] })(tree)

    const spans = spansOf(tree)
    expect(spans.map((s) => s.children?.[0].value)).toEqual(['two', 'words'])
    expect(spans.map((s) => s.properties?.style)).toEqual([
      'animation-delay: 0ms',
      'animation-delay: 36ms',
    ])
  })

  it('leaves generated (position-less) text unwrapped and its batch delays unshifted', () => {
    const generated: TestNode = { type: 'text', value: 'generated scaffolding' }
    const tree = paragraph([
      { type: 'text', value: 'sourced words', position: { start: { offset: 0 } } },
      generated,
    ])

    rehypeStreamingWordReveal({ batchStarts: [0] })(tree)

    const spans = spansOf(tree)
    // Only the sourced words are wrapped; the generated text node survives as-is,
    // so it can neither replay with a stale delay nor shift batch 0's stagger.
    expect(spans.map((s) => s.children?.[0].value)).toEqual(['sourced', 'words'])
    expect(spans.map((s) => s.properties?.style)).toEqual([
      'animation-delay: 0ms',
      'animation-delay: 36ms',
    ])
    expect(tree.children?.[0].children).toContain(generated)
  })
})

// What the word spans animate is decided in globals.css, not here, so the
// stylesheet is read as text. A reply mid-stream has a dozen or more words
// revealing at once, each on its own compositor layer; a `filter` on each adds
// a blur pass per word per frame in the GPU process (see the comment above the
// keyframes). These pin the animation to opacity alone.
describe('streaming word reveal styles', () => {
  const css = readFileSync(path.resolve(__dirname, '../../globals.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  /** The body of the first block that starts at `header`, braces balanced. */
  function blockAfter(source: string, header: string, from = 0): { body: string; end: number } | null {
    const start = source.indexOf(header, from)
    if (start === -1) return null
    const open = source.indexOf('{', start)
    let depth = 0
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}' && --depth === 0) return { body: source.slice(open + 1, i), end: i + 1 }
    }
    return null
  }

  function declaredProperties(body: string): string[] {
    return body
      .replace(/[^{}]*\{/g, '')
      .split(/[;}]/)
      .map((declaration) => declaration.split(':')[0].trim())
      .filter(Boolean)
  }

  /** Every rule body whose selector names the word span, with its enclosing at-rule. */
  function wordRules(): Array<{ body: string; media: string | null }> {
    const rules: Array<{ body: string; media: string | null }> = []
    const pattern = /(?:^|[}{;])\s*([^{};@]*\.streaming-word-reveal[^{};]*)\{([^{}]*)\}/g
    for (const match of css.matchAll(pattern)) {
      const before = css.slice(0, match.index)
      const mediaStart = before.lastIndexOf('@media')
      const enclosing = mediaStart === -1 ? null : blockAfter(css, '@media', mediaStart)
      const inside = enclosing !== null && enclosing.end > (match.index ?? 0)
      rules.push({
        body: match[2],
        media: inside ? css.slice(mediaStart, css.indexOf('{', mediaStart)).trim() : null,
      })
    }
    return rules
  }

  it('animates opacity and nothing else', () => {
    const keyframes = blockAfter(css, '@keyframes streaming-word-reveal')
    expect(keyframes).not.toBeNull()
    expect(new Set(declaredProperties(keyframes!.body))).toEqual(new Set(['opacity']))
    // Exactly one definition: a second `@keyframes` of the same name would win.
    expect(css.split('@keyframes streaming-word-reveal').length - 1).toBe(1)
  })

  it('puts no filter, backdrop-filter or will-change on a word span', () => {
    const rules = wordRules()
    expect(rules.length).toBeGreaterThan(0)
    for (const { body } of rules) {
      expect(declaredProperties(`${body}}`)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^(-webkit-)?(backdrop-)?filter$|^will-change$/)]),
      )
    }
  })

  it('runs one finite animation that leaves nothing applied when it ends', () => {
    const base = wordRules().filter((rule) => rule.media === null)
    expect(base).toHaveLength(1)
    const animation = /animation:\s*([^;]+);/.exec(base[0].body)?.[1] ?? ''
    expect(animation).toMatch(/^streaming-word-reveal\s+\d+ms\b/)
    expect(animation).toMatch(/\bbackwards$/)
    // A comma outside the easing function would be a second animation.
    expect(animation.replace(/\([^)]*\)/g, '()')).not.toMatch(/infinite|forwards|both|,/)
  })

  it('reveals nothing under prefers-reduced-motion', () => {
    const reduced = wordRules().filter((rule) => rule.media?.includes('prefers-reduced-motion: reduce'))
    expect(reduced).toHaveLength(1)
    expect(reduced[0].body.replace(/\s+/g, ' ').trim()).toBe('animation: none;')
  })

  it('gives each word span a delay and no other inline style', () => {
    const tree = paragraph([
      { type: 'text', value: 'one two three', position: { start: { offset: 0 } } },
    ])

    rehypeStreamingWordReveal({ batchStarts: [0] })(tree)

    for (const span of spansOf(tree)) {
      expect(span.properties).toEqual({
        className: ['streaming-word-reveal'],
        style: expect.stringMatching(/^animation-delay: \d+ms$/),
      })
    }
  })
})
