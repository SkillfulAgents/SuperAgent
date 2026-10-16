// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HtmlBlock } from './html-block'

describe('HtmlBlock', () => {
  it('keeps the preview when its document changes and changes back before the new one loads', () => {
    const fallback = <pre>source</pre>
    const { rerender } = render(<HtmlBlock source="<p>Light</p>" fallback={fallback} />)
    const frame = screen.getByTitle('HTML preview')

    fireEvent.load(frame)
    rerender(<HtmlBlock source="<p>Dark</p>" fallback={fallback} />)
    rerender(<HtmlBlock source="<p>Light</p>" fallback={fallback} />)
    fireEvent.load(frame)

    expect(screen.getByTitle('HTML preview')).toBe(frame)
  })

  it('shows the preview without a copy button', () => {
    render(<HtmlBlock source="<p>Hello</p>" fallback={<pre>source</pre>} />)

    expect(screen.getByTitle('HTML preview')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
