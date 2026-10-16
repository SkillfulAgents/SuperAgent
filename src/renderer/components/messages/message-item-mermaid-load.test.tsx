// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MarkdownBlock } from './message-item'

// Simulates the lazy chunk failing to load, e.g. after an app update replaced it.
vi.mock('./mermaid-diagram', () => {
  throw new Error('Failed to fetch dynamically imported module')
})

describe('mermaid chunk failure', () => {
  it('falls back to the code block and keeps the rest of the message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const text = 'Here is the flow:\n\n```mermaid\ngraph LR\n  Request --> Response\n```'
    const { container } = render(<MarkdownBlock text={text} />)

    // Let the lazy import reject; before that, Suspense already shows the same code block.
    await act(async () => {
      await import('./mermaid-diagram').catch(() => {})
    })

    expect(container.querySelector('pre')).toHaveTextContent('Request --> Response')
    expect(screen.getByText('Here is the flow:')).toBeInTheDocument()
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull()
  })
})
