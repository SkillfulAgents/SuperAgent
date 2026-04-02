// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { PendingRequestStack, usePagination } from './pending-request-stack'

// Helper component to consume and display pagination context
function PaginationDisplay() {
  const pagination = usePagination()
  if (!pagination) return <span data-testid="no-pagination" />
  return (
    <div data-testid="pagination-info">
      <span data-testid="current-index">{pagination.currentIndex}</span>
      <span data-testid="count">{pagination.count}</span>
      <button data-testid="go-prev" onClick={pagination.goPrev}>Prev</button>
      <button data-testid="go-next" onClick={pagination.goNext}>Next</button>
    </div>
  )
}

function Card({ id, label }: { id: string; label: string }) {
  return (
    <div data-testid={`card-${id}`}>
      <PaginationDisplay />
      <span>{label}</span>
    </div>
  )
}

describe('PendingRequestStack', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null when there are no children', () => {
    const { container } = render(
      <PendingRequestStack>{[]}</PendingRequestStack>
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders a single child', () => {
    render(
      <PendingRequestStack>
        {[<Card key="a" id="a" label="Card A" />]}
      </PendingRequestStack>
    )
    expect(screen.getByTestId('card-a')).toBeInTheDocument()
    expect(screen.getByText('Card A')).toBeInTheDocument()
  })

  it('only shows the first child when there are multiple', () => {
    render(
      <PendingRequestStack>
        {[
          <Card key="a" id="a" label="Card A" />,
          <Card key="b" id="b" label="Card B" />,
          <Card key="c" id="c" label="Card C" />,
        ]}
      </PendingRequestStack>
    )

    // All cards are in the DOM (grid trick for height)
    expect(screen.getByTestId('card-a')).toBeInTheDocument()
    expect(screen.getByTestId('card-b')).toBeInTheDocument()
    expect(screen.getByTestId('card-c')).toBeInTheDocument()

    // Only the first card is visible
    const cardAWrapper = screen.getByTestId('card-a').parentElement!
    const cardBWrapper = screen.getByTestId('card-b').parentElement!
    expect(cardAWrapper.style.visibility).toBe('visible')
    expect(cardBWrapper.style.visibility).toBe('hidden')
  })

  it('provides pagination context to children', () => {
    render(
      <PendingRequestStack>
        {[
          <Card key="a" id="a" label="Card A" />,
          <Card key="b" id="b" label="Card B" />,
        ]}
      </PendingRequestStack>
    )

    // Both cards render PaginationDisplay (both in DOM, one hidden via CSS)
    // All instances share the same context values
    const indices = screen.getAllByTestId('current-index')
    expect(indices[0].textContent).toBe('0')
    const counts = screen.getAllByTestId('count')
    expect(counts[0].textContent).toBe('2')
  })

  it('navigates to next card on goNext', () => {
    render(
      <PendingRequestStack>
        {[
          <Card key="a" id="a" label="Card A" />,
          <Card key="b" id="b" label="Card B" />,
        ]}
      </PendingRequestStack>
    )

    // Click next on the visible card
    const nextButtons = screen.getAllByTestId('go-next')
    act(() => {
      nextButtons[0].click()
    })

    // Now card B should be visible, card A hidden
    const cardAWrapper = screen.getByTestId('card-a').parentElement!
    const cardBWrapper = screen.getByTestId('card-b').parentElement!
    expect(cardAWrapper.style.visibility).toBe('hidden')
    expect(cardBWrapper.style.visibility).toBe('visible')
  })

  it('navigates back on goPrev', () => {
    render(
      <PendingRequestStack>
        {[
          <Card key="a" id="a" label="Card A" />,
          <Card key="b" id="b" label="Card B" />,
        ]}
      </PendingRequestStack>
    )

    // Go next then prev
    const nextButtons = screen.getAllByTestId('go-next')
    act(() => {
      nextButtons[0].click()
    })
    const prevButtons = screen.getAllByTestId('go-prev')
    act(() => {
      prevButtons[0].click()
    })

    const cardAWrapper = screen.getByTestId('card-a').parentElement!
    expect(cardAWrapper.style.visibility).toBe('visible')
  })

  it('does not navigate past the last card', () => {
    render(
      <PendingRequestStack>
        {[
          <Card key="a" id="a" label="Card A" />,
          <Card key="b" id="b" label="Card B" />,
        ]}
      </PendingRequestStack>
    )

    // Click next twice (only 2 items)
    const nextButtons = screen.getAllByTestId('go-next')
    act(() => {
      nextButtons[0].click()
    })
    act(() => {
      nextButtons[0].click()
    })

    // Card B should still be visible (clamped to last index)
    const cardBWrapper = screen.getByTestId('card-b').parentElement!
    expect(cardBWrapper.style.visibility).toBe('visible')
  })

  it('does not navigate before the first card', () => {
    render(
      <PendingRequestStack>
        {[
          <Card key="a" id="a" label="Card A" />,
          <Card key="b" id="b" label="Card B" />,
        ]}
      </PendingRequestStack>
    )

    // Click prev at index 0
    const prevButtons = screen.getAllByTestId('go-prev')
    act(() => {
      prevButtons[0].click()
    })

    const cardAWrapper = screen.getByTestId('card-a').parentElement!
    expect(cardAWrapper.style.visibility).toBe('visible')
  })

  it('clamps index when items are removed', () => {
    const { rerender } = render(
      <PendingRequestStack>
        {[
          <Card key="a" id="a" label="Card A" />,
          <Card key="b" id="b" label="Card B" />,
          <Card key="c" id="c" label="Card C" />,
        ]}
      </PendingRequestStack>
    )

    // Navigate to last card (index 2)
    const nextButtons = screen.getAllByTestId('go-next')
    act(() => {
      nextButtons[0].click()
    })
    act(() => {
      nextButtons[0].click()
    })

    // Remove last two cards
    rerender(
      <PendingRequestStack>
        {[<Card key="a" id="a" label="Card A" />]}
      </PendingRequestStack>
    )

    // Index should clamp to 0 (only 1 item left)
    const cardAWrapper = screen.getByTestId('card-a').parentElement!
    expect(cardAWrapper.style.visibility).toBe('visible')
  })

  it('renders stack strips for multiple children', () => {
    const { container } = render(
      <PendingRequestStack>
        {[
          <Card key="a" id="a" label="Card A" />,
          <Card key="b" id="b" label="Card B" />,
          <Card key="c" id="c" label="Card C" />,
        ]}
      </PendingRequestStack>
    )

    // Stack strips have rounded-t-[12px] class
    const strips = container.querySelectorAll('.rounded-t-\\[12px\\]')
    expect(strips.length).toBeGreaterThan(0)
  })

  it('no stack strips for a single child', () => {
    const { container } = render(
      <PendingRequestStack>
        {[<Card key="a" id="a" label="Card A" />]}
      </PendingRequestStack>
    )

    const strips = container.querySelectorAll('.rounded-t-\\[12px\\]')
    expect(strips.length).toBe(0)
  })

  it('triggers dismiss animation when a child is removed', () => {
    const { container, rerender } = render(
      <PendingRequestStack>
        {[
          <Card key="a" id="a" label="Card A" />,
          <Card key="b" id="b" label="Card B" />,
        ]}
      </PendingRequestStack>
    )

    // Remove card A
    rerender(
      <PendingRequestStack>
        {[<Card key="b" id="b" label="Card B" />]}
      </PendingRequestStack>
    )

    // The dismiss overlay should be present (pointer-events-none)
    const dismissOverlay = container.querySelector('.pointer-events-none')
    expect(dismissOverlay).toBeInTheDocument()

    // After the animation duration, the overlay should be removed
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    const dismissOverlayAfter = container.querySelector('.pointer-events-none')
    expect(dismissOverlayAfter).not.toBeInTheDocument()
  })

  it('does not render dismiss animation on initial mount', () => {
    const { container } = render(
      <PendingRequestStack>
        {[
          <Card key="a" id="a" label="Card A" />,
          <Card key="b" id="b" label="Card B" />,
        ]}
      </PendingRequestStack>
    )

    const dismissOverlay = container.querySelector('.pointer-events-none')
    expect(dismissOverlay).not.toBeInTheDocument()
  })

  it('still renders during dismiss animation even when count is 0', () => {
    const { container, rerender } = render(
      <PendingRequestStack>
        {[<Card key="a" id="a" label="Card A" />]}
      </PendingRequestStack>
    )

    // Remove the only card
    rerender(
      <PendingRequestStack>{[]}</PendingRequestStack>
    )

    // Should still render (dismiss animation in progress)
    const dismissOverlay = container.querySelector('.pointer-events-none')
    expect(dismissOverlay).toBeInTheDocument()

    // After animation completes, should return null
    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(container.innerHTML).toBe('')
  })

  it('provides null pagination context outside of stack', () => {
    render(<PaginationDisplay />)
    expect(screen.getByTestId('no-pagination')).toBeInTheDocument()
  })
})
