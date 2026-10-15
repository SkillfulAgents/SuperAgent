// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import { NO_MARKDOWN_IMAGES } from './shared'

function md(source: string) {
  return render(<ReactMarkdown components={NO_MARKDOWN_IMAGES}>{source}</ReactMarkdown>)
}

describe('NO_MARKDOWN_IMAGES', () => {
  it('never loads an image, and stands in the alt text when the page gave one', () => {
    // Web tool results are page-authored, so an <img> here would be an outbound request on a
    // URL the page picked, fired on every card render.
    const { container } = md('Chart: ![Voice cloning benchmark](https://tracker.example/p.png)')
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(/Voice cloning benchmark/)).toBeTruthy()
  })

  it('drops decorative images rather than leaving a run of placeholders', () => {
    // Real fetched pages carry rows of empty-alt logos; a marker each reads as noise.
    const { container } = md('Trusted by ![](https://a.example/1.svg)![](https://a.example/2.svg) us')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).not.toContain('[image')
    expect(container.textContent?.replace(/\s+/g, ' ')).toBe('Trusted by us')
  })
})
