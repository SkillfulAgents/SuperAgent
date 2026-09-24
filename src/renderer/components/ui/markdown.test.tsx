// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Markdown } from './markdown'

describe('Markdown', () => {
  afterEach(cleanup)

  it('opens links in a new window with noopener by default', () => {
    render(<Markdown>[Docs](https://example.com/docs)</Markdown>)
    const link = screen.getByRole('link', { name: 'Docs' })
    expect(link).toHaveAttribute('href', 'https://example.com/docs')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('applies the shared plugins: GFM autolinks with fullwidth trail handling', () => {
    const { container } = render(<Markdown>Pushed to **https://github.com/acme/widget-kit**（public）。</Markdown>)
    expect(container.querySelector('strong a')).toHaveAttribute('href', 'https://github.com/acme/widget-kit')
  })

  it('merges caller components over the defaults', () => {
    const components = { a: ({ children }: { children?: React.ReactNode }) => <button type="button">{children}</button> }
    render(<Markdown components={components}>[Go](https://example.com) **b**</Markdown>)
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
