// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MarkdownBlock } from '@renderer/components/messages/message-item'

// Renders the real MarkdownBlock so the per-callsite plugin wiring is covered.
describe('remarkTrimAutolinkLiteral', () => {
  afterEach(cleanup)

  it('keeps fullwidth punctuation and the closing ** out of a bare URL href', () => {
    const { container } = render(
      <MarkdownBlock text="Pushed to GitHub：**https://github.com/acme/widget-kit**（public，MIT）。" />
    )
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', 'https://github.com/acme/widget-kit')
    expect(link).toHaveTextContent('https://github.com/acme/widget-kit')
    expect(container.textContent).toBe('Pushed to GitHub：https://github.com/acme/widget-kit（public，MIT）。')
  })

  it('restores the strong emphasis whose closing ** the autolink swallowed', () => {
    const { container } = render(
      <MarkdownBlock text="See **https://github.com/acme/widget-kit**（public）。" />
    )
    const strong = container.querySelector('strong')
    expect(strong).not.toBeNull()
    expect(strong?.querySelector('a')).toHaveAttribute('href', 'https://github.com/acme/widget-kit')
    expect(container.textContent).toBe('See https://github.com/acme/widget-kit（public）。')
  })

  it('restores single-asterisk emphasis the same way', () => {
    const { container } = render(<MarkdownBlock text="See *https://example.com/a*。" />)
    expect(container.querySelector('em a')).toHaveAttribute('href', 'https://example.com/a')
    expect(container.textContent).toBe('See https://example.com/a。')
  })

  it('hands trailing fullwidth punctuation back to the prose without emphasis', () => {
    const { container } = render(<MarkdownBlock text="Repo at https://example.com/repo。" />)
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/repo')
    expect(container.textContent).toBe('Repo at https://example.com/repo。')
  })

  it('leaves autolinks GFM already handled untouched', () => {
    const { container } = render(<MarkdownBlock text="See **https://example.com/a** (public, MIT)." />)
    expect(container.querySelector('strong a')).toHaveAttribute('href', 'https://example.com/a')
    expect(container.textContent).toBe('See https://example.com/a (public, MIT).')
  })

  it('leaves explicit [text](url) links alone', () => {
    render(<MarkdownBlock text="[repo](https://example.com/a。)" />)
    // Authored hrefs are the author's business; only bare literals are trimmed.
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/a%E3%80%82')
  })

  it('leaves an explicit link alone even when its label equals the URL suffix', () => {
    render(<MarkdownBlock text="[report_](https://example.com/report_)" />)
    expect(screen.getByRole('link', { name: 'report_' })).toHaveAttribute('href', 'https://example.com/report_')
  })

  it('leaves <url> autolinks alone', () => {
    render(<MarkdownBlock text="<https://example.com/report_> and <https://example.com/a（b）>" />)
    const links = screen.getAllByRole('link')
    expect(links[0]).toHaveAttribute('href', 'https://example.com/report_')
    expect(links[1]).toHaveAttribute('href', 'https://example.com/a%EF%BC%88b%EF%BC%89')
  })

  it('keeps a Japanese path whose characters live in the CJK Symbols block', () => {
    render(<MarkdownBlock text="See https://example.com/people/佐々木" />)
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/people/%E4%BD%90%E3%80%85%E6%9C%A8')
  })

  it('keeps a CJK path that is not punctuation', () => {
    render(<MarkdownBlock text="See https://zh.wikipedia.org/wiki/中文" />)
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87')
  })
})
