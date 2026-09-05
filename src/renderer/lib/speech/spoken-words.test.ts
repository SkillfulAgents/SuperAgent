import { describe, it, expect } from 'vitest'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import type { Nodes, Root } from 'hast'
import { collectSpokenWords, markdownToSpokenWords, rehypeSpokenWords } from './spoken-words'

function spokenText(markdown: string): string {
  return markdownToSpokenWords(markdown).map((w) => (w.blockEnd ? `${w.text}|` : w.text)).join(' ')
}

/** Just enough HTML serialization to assert on span placement. */
function toHtml(node: Nodes): string {
  switch (node.type) {
    case 'text':
      return node.value
    case 'root':
      return node.children.map(toHtml).join('')
    case 'element': {
      const index = node.properties.dataSpokenWord
      const attrs = index === undefined ? '' : ` data-spoken-word="${index}"`
      return `<${node.tagName}${attrs}>${node.children.map(toHtml).join('')}</${node.tagName}>`
    }
    default:
      return ''
  }
}

/** Render the way react-markdown would, with the spoken-word plugin applied. */
function renderWithSpans(markdown: string): string {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSpokenWords)
  const tree = processor.runSync(processor.parse(markdown)) as Root
  return toHtml(tree)
}

describe('markdownToSpokenWords', () => {
  it('yields prose words with block ends at paragraph boundaries', () => {
    expect(spokenText('Hello world.\n\nSecond paragraph here.')).toBe('Hello world.| Second paragraph here.|')
  })

  it('drops markdown syntax but keeps the words', () => {
    expect(spokenText('**Bold** and _italic_ with a [link](https://x.test) and `code`.'))
      .toBe('Bold and italic with a link and code.|')
  })

  it('never speaks fenced code blocks', () => {
    expect(spokenText('Run this:\n\n```sh\nnpm test\n```\n\nThen done.')).toBe('Run this:| Then done.|')
  })

  it('never speaks image alt text or raw HTML', () => {
    expect(spokenText('Look ![a cat](cat.png) here <br> now')).toBe('Look here now|')
  })

  it('joins a word that inline markup split, so punctuation stays attached', () => {
    expect(spokenText('Use `grep`. Then **un**believable, right?')).toBe('Use grep. Then unbelievable, right?|')
  })

  it('ends a block after headings and each list item', () => {
    expect(spokenText('## Plan\n\n- first step\n- second step\n\n1. numbered')).toBe(
      'Plan| first step| second step| numbered|',
    )
  })

  it('ends a block per table row, not per cell', () => {
    expect(spokenText('| Name | Age |\n| --- | --- |\n| Ann | 30 |')).toBe('Name Age| Ann 30|')
  })

  it('returns nothing for an empty or code-only message', () => {
    expect(markdownToSpokenWords('')).toEqual([])
    expect(markdownToSpokenWords('```\nonly code\n```')).toEqual([])
  })
})

describe('rehypeSpokenWords', () => {
  it('wraps each spoken word in an indexed span, in the same order as collection', () => {
    const md = 'Hi **there**, `friend`.\n\n- item one'
    const html = renderWithSpans(md)
    const words = markdownToSpokenWords(md)
    const indices = [...html.matchAll(/data-spoken-word="(\d+)"/g)].map((m) => Number(m[1]))
    // "there," and "friend." are each one word rendered as two spans
    expect(indices).toEqual([0, 1, 1, 2, 2, 3, 4])
    expect(words.map((w) => w.text)).toEqual(['Hi', 'there,', 'friend.', 'item', 'one'])
    expect(html).toContain('<span data-spoken-word="0">Hi</span>')
    expect(html).toContain('<strong><span data-spoken-word="1">there</span></strong>')
    expect(html).toContain('<code><span data-spoken-word="2">friend</span></code>')
  })

  it('a word split by inline markup keeps one index across its spans', () => {
    const html = renderWithSpans('**bold**, then `code`. Done')
    expect(html).toContain('<strong><span data-spoken-word="0">bold</span></strong><span data-spoken-word="0">,</span>')
    expect(html).toContain('<code><span data-spoken-word="2">code</span></code><span data-spoken-word="2">.</span>')
    expect(html).toContain('<span data-spoken-word="3">Done</span>')
  })

  it('leaves code blocks untouched', () => {
    const html = renderWithSpans('```js\nlet x = 1\n```')
    expect(html).not.toContain('data-spoken-word')
    expect(html).toContain('let x = 1')
  })

  it('preserves whitespace between words', () => {
    const html = renderWithSpans('one  two')
    expect(html).toContain('<span data-spoken-word="0">one</span>  <span data-spoken-word="1">two</span>')
  })

  it('agrees with collectSpokenWords on the same tree', () => {
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true })
    const md = '# Title\n\nSome *text* here.\n\n> quoted words'
    const tree = processor.runSync(processor.parse(md)) as Root
    const collected = collectSpokenWords(tree)
    expect(collected).toEqual(markdownToSpokenWords(md))
  })
})
