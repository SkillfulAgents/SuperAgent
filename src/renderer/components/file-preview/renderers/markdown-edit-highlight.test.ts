import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { REMARK_PLUGINS } from '@renderer/lib/remark-plugins'
import type { Element, Root } from 'hast'
import { diffEditedLines, rehypeEditHighlight } from './markdown-edit-highlight'

/** Each top-level block, or list item, as `tag` or `tag:edit`. */
function marks(before: string, now: string): string[] {
  // The app's own remark plugins, so tables and other GFM blocks parse as they render.
  const processor = unified().use(remarkParse).use(REMARK_PLUGINS).use(remarkRehype)
  const tree: Root = processor.runSync(processor.parse(now))
  const lines = diffEditedLines(before, now)
  if (!lines) throw new Error('diff timed out')
  rehypeEditHighlight(lines)(tree)
  const label = (node: Element) => node.properties.dataEdit ? `${node.tagName}:${node.properties.dataEdit}` : node.tagName
  return tree.children.filter((node): node is Element => node.type === 'element').flatMap(node =>
    node.tagName === 'ul'
      ? node.children.filter((item): item is Element => item.type === 'element').map(label)
      : [label(node)])
}

describe('rehypeEditHighlight', () => {
  const doc = '# Title\n\nFirst paragraph.\n\n- one\n- two\n- three\n\nLast paragraph.\n'

  it('marks nothing when nothing changed', () => {
    expect(marks(doc, doc)).toEqual(['h1', 'p', 'li', 'li', 'li', 'p'])
  })

  it('marks only the list item that changed', () => {
    expect(marks(doc, doc.replace('- two', '- deux'))).toEqual(['h1', 'p', 'li', 'li:changed', 'li', 'p'])
  })

  it('marks an added block', () => {
    expect(marks(doc, doc.replace('First paragraph.\n', 'First paragraph.\n\nNew one.\n')))
      .toEqual(['h1', 'p', 'p:changed', 'li', 'li', 'li', 'p'])
  })

  it('marks the block below a removed block, or the last block when the end was removed', () => {
    expect(marks(doc, doc.replace('First paragraph.\n\n', ''))).toEqual(['h1', 'li:removed-above', 'li', 'li', 'p'])
    expect(marks(doc, doc.replace('\nLast paragraph.\n', ''))).toEqual(['h1', 'p', 'li', 'li', 'li:removed-below'])
  })

  it('marks a changed table row as its table changing', () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |\n'
    expect(marks(table, table.replace('| 1 | 2 |', '| 1 | 3 |'))).toEqual(['table:changed'])
  })

  it('treats a missing trailing newline as no change', () => {
    expect(marks(doc, doc.trimEnd())).toEqual(['h1', 'p', 'li', 'li', 'li', 'p'])
  })

  it('marks a block changed when a line inside it was removed', () => {
    const code = '```\na\nb\nc\n```\n'
    expect(marks(code, code.replace('b\n', ''))).toEqual(['pre:changed'])
  })
})
