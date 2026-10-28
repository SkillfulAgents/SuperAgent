import { describe, it, expect } from 'vitest'
import { stripMarkdownPreview } from './markdown-preview'

describe('stripMarkdownPreview', () => {
  it('strips emphasis, links, and list markers into one line', () => {
    expect(
      stripMarkdownPreview(
        'This is a **markdown** body with a [link](https://gamutagents.com).\n\n- bullet one\n- bullet two',
      ),
    ).toBe('This is a markdown body with a link. bullet one bullet two')
  })

  it('keeps image alt text and inline code content', () => {
    expect(stripMarkdownPreview('See ![diagram](https://x/img.png) and run `npm i`')).toBe(
      'See diagram and run npm i',
    )
  })

  it('drops headings, blockquotes, hrules, and code fences', () => {
    expect(
      stripMarkdownPreview('# Big news\n\n> quoted\n\n---\n\n```js\nconst x = 1\n```\nDone'),
    ).toBe('Big news quoted Done')
  })

  it('handles bold-italic and strikethrough', () => {
    expect(stripMarkdownPreview('***very*** important, ~~not~~ now')).toBe(
      'very important, not now',
    )
  })

  it('passes plain text through unchanged', () => {
    expect(stripMarkdownPreview('Just a plain sentence.')).toBe('Just a plain sentence.')
  })
})
