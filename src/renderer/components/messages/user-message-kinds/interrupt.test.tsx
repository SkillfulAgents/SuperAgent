// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { InterruptMarkerChip, interruptMarker } from './interrupt'
import type { ApiMessage } from '@shared/lib/types/api'

const message = {
  id: 'm1',
  type: 'user',
  content: { text: '' },
  createdAt: new Date('2025-01-01T10:30:00Z'),
} as unknown as ApiMessage

describe('InterruptMarkerChip', () => {
  it('renders a bare "Stopped" chip and never touches the Markdown body', () => {
    const renderMarkdown = vi.fn()
    render(<InterruptMarkerChip text="[Request interrupted by user]" message={message} renderMarkdown={renderMarkdown} />)

    expect(screen.getByTestId('interrupt-marker')).toHaveTextContent('Stopped')
    expect(screen.queryByText(/interrupted by user/)).not.toBeInTheDocument()
    expect(renderMarkdown).not.toHaveBeenCalled()
  })

  it('says the tool never ran for the tool-use variant', () => {
    render(<InterruptMarkerChip text="[Request interrupted by user for tool use]" message={message} renderMarkdown={vi.fn()} />)
    expect(screen.getByTestId('interrupt-marker')).toHaveTextContent('Stopped before the tool ran')
  })

  it('is registered as a bare kind', () => {
    expect(interruptMarker.chrome).toBe('bare')
    expect(interruptMarker.hidden).toBe(false)
  })
})
