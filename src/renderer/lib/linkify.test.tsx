// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { linkify } from './linkify'

describe('linkify', () => {
  it('returns the input string unchanged when it holds no URL', () => {
    // The no-visual-change guarantee for the ten request cards whose prose has
    // no link: identical return value means identical DOM, not merely similar.
    const text = 'Approve access for the DataWizz workspace, then come back here.'
    expect(linkify(text)).toBe(text)
  })

  it('links a bare https URL and keeps the surrounding prose', () => {
    render(<>{linkify('Open https://app.clay.com/oauth/device?user_code=LCWW-PKKC then return')}</>)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', 'https://app.clay.com/oauth/device?user_code=LCWW-PKKC')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByText(/then return/)).toBeInTheDocument()
  })

  it('refuses dangerous schemes, leaving them as plain text', () => {
    // Card prose is agent-authored. These schemes never enter the candidate
    // regex (https?/mailto/tel/sms only); safeHref is the second gate for
    // candidates that do match, shared with the markdown renderer.
    for (const hostile of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'file:///etc/passwd']) {
      const { container, unmount } = render(<>{linkify(`click ${hostile} now`)}</>)
      expect(container.querySelector('a')).toBeNull()
      unmount()
    }
  })

  it('keeps tel: and mailto: linkable, matching the markdown renderer', () => {
    render(<>{linkify('call tel:+15551234567 or mailto:ops@example.com')}</>)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(2)
    expect(links[0]).toHaveAttribute('href', 'tel:+15551234567')
    expect(links[1]).toHaveAttribute('href', 'mailto:ops@example.com')
  })

  it('does not swallow trailing sentence punctuation into the href', () => {
    const { container } = render(<>{linkify('Approve at https://example.com/path.')}</>)
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/path')
    // Trimming the period off the href must hand it back to the prose, not eat
    // it: a loop that advanced past the untrimmed match would drop it silently.
    expect(container.textContent).toBe('Approve at https://example.com/path.')
  })

  it('keeps balanced parentheses that belong to the URL', () => {
    render(<>{linkify('see https://en.wikipedia.org/wiki/Foo_(bar) for detail')}</>)
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Foo_(bar)')
  })

  it('returns an unbalanced closing bracket to the prose', () => {
    const { container } = render(<>{linkify('see https://example.com/a(b)) now')}</>)
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com/a(b)')
    expect(container.textContent).toBe('see https://example.com/a(b)) now')
  })

  it('keeps prose delimiters that wrap a URL out of the href', () => {
    for (const [prose, text] of [
      ['Open <https://example.com/login>', 'https://example.com/login'],
      ['Open "https://example.com/login" now', 'https://example.com/login'],
      ['Open `https://example.com/login` now', 'https://example.com/login'],
    ]) {
      const { container, unmount } = render(<>{linkify(prose)}</>)
      expect(screen.getByRole('link')).toHaveAttribute('href', text)
      expect(container.textContent).toBe(prose)
      unmount()
    }
  })

  it('keeps a single quote that is legal inside the URL', () => {
    // RFC 3986 sub-delim. Excluding it to catch 'https://x'-style wrappers cost
    // more than it bought: real API URLs carry raw quotes, agents do not wrap in
    // them, and telling the two apart is not decidable from the string.
    const url = "https://graph.microsoft.com/v1.0/users?$filter=startswith(displayName,'J')"
    const { container } = render(<>{linkify(`Open ${url} now`)}</>)
    expect(screen.getByRole('link')).toHaveAttribute('href', url)
    expect(container.textContent).toBe(`Open ${url} now`)
  })
})
