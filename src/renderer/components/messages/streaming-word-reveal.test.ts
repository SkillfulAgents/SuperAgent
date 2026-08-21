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
