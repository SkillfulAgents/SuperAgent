import { describe, expect, it } from 'vitest'
import { splitFrontmatter } from './markdown-frontmatter'

describe('splitFrontmatter', () => {
  it('takes the leading block out and keeps every later line where it was', () => {
    const text = '---\ntitle: Overview\nsensitivity: public\n---\n# Overview\nBody.'
    const { frontmatter, body } = splitFrontmatter(text)
    expect(frontmatter).toBe('title: Overview\nsensitivity: public')
    expect(body.split('\n').indexOf('# Overview')).toBe(text.split('\n').indexOf('# Overview'))
  })

  it('leaves a file with no leading block, or a rule further down, as it is', () => {
    // A file that opens with a rule and has another further down is a document, not metadata.
    for (const text of ['# Title\n\n---\n\nmore', ' ---\na: 1\n---\n', '---\nnever closed\n', '', '---\n# Report\n\nRead [plan](plan.md)\n\n---\nBody', '---\nhttps://example.com\n\n[Plan](plan.md)\n\n---\n']) {
      expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text })
    }
  })

  it('reads metadata that opens with a comment or a blank line', () => {
    expect(splitFrontmatter('---\n# exported\n\ntitle: A\n---\nBody')).toMatchObject({ frontmatter: '# exported\n\ntitle: A' })
  })

  it('reads Windows line endings and a block that is the whole file', () => {
    expect(splitFrontmatter('---\r\na: 1\r\n---\r\nBody')).toMatchObject({ frontmatter: 'a: 1' })
    expect(splitFrontmatter('---\na: 1\n---')).toEqual({ frontmatter: 'a: 1', body: '\n\n' })
  })
})
