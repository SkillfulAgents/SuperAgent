// @vitest-environment jsdom
/**
 * Unified pagination across a multi-card stack and per-card sub-pages.
 *
 * Goal: when a stack has K cards and one of them has N internal sub-pages,
 * the header chevrons should advance through every sub-page in order
 * (sum of sub-counts), not skip over them card-by-card.
 *
 * Test cards publish their sub-page state via `useSubPagination`. The hook
 * is currently a no-op — these tests describe the desired post-fix behavior
 * and will fail until the stack consumes the registry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useState } from 'react'
import { PendingRequestStack, useSubPagination } from './pending-request-stack'
import { RequestItemShell } from './request-item-shell'

// -- Test fixtures --------------------------------------------------------

/** A card that publishes N sub-pages and renders the active sub-page index. */
function MultiPageTestCard({
  id,
  pages,
  initialIndex = 0,
}: {
  id: string
  pages: number
  initialIndex?: number
}) {
  const [index, setIndex] = useState(initialIndex)
  useSubPagination({ count: pages, index, setIndex })
  return (
    <RequestItemShell title={`${id}-p${index}`} theme="blue" data-testid={`card-${id}`}>
      <div data-testid={`${id}-content`}>
        {id} sub-page {index} of {pages}
      </div>
      <input data-testid={`${id}-input`} defaultValue="" />
    </RequestItemShell>
  )
}

/** A card with no internal pagination — should default to a sub-count of 1. */
function SinglePageTestCard({ id }: { id: string }) {
  return (
    <RequestItemShell title={id} theme="blue" data-testid={`card-${id}`}>
      <div data-testid={`${id}-content`}>{id}</div>
    </RequestItemShell>
  )
}

/** A card whose sub-count can change after mount, to test dynamic registration. */
function DynamicSubCountCard({ id, pages }: { id: string; pages: number }) {
  const [index, setIndex] = useState(0)
  useSubPagination({ count: pages, index, setIndex })
  return (
    <RequestItemShell title={`${id}-p${index}`} theme="blue" data-testid={`card-${id}`}>
      <div data-testid={`${id}-content`}>
        {id} sub-page {index} of {pages}
      </div>
    </RequestItemShell>
  )
}

// -- Helpers --------------------------------------------------------------

function clickNext() {
  act(() => {
    screen.getAllByTestId('request-stack-next')[0].click()
  })
}

function clickPrev() {
  act(() => {
    screen.getAllByTestId('request-stack-prev')[0].click()
  })
}

function paginationState(): { current: number; total: number } | null {
  const els = screen.queryAllByTestId('request-stack-pagination')
  if (els.length === 0) return null
  const el = els[0]
  const current = Number(el.getAttribute('data-current-index'))
  const total = Number(el.getAttribute('data-count'))
  return { current, total }
}

function paginationLabel(): string | null {
  const els = screen.queryAllByText(/^\d+ of \d+$/)
  return els[0]?.textContent ?? null
}

/** Walks up from the data-testid'd shell to find the stack wrapper's
 *  visibility style (set explicitly to 'visible' or 'hidden' on the
 *  per-card wrapper inside PendingRequestStack). */
function isCardVisible(id: string): boolean {
  const card = screen.getByTestId(`card-${id}`)
  let el: HTMLElement | null = card.parentElement
  while (el) {
    const v = el.style?.visibility
    if (v === 'hidden') return false
    if (v === 'visible') return true
    el = el.parentElement
  }
  // No explicit visibility means single-card stack — visible by default.
  return true
}

function isNextDisabled(): boolean {
  const btn = screen.getAllByTestId('request-stack-next')[0] as HTMLButtonElement
  return btn.disabled
}

function isPrevDisabled(): boolean {
  const btn = screen.getAllByTestId('request-stack-prev')[0] as HTMLButtonElement
  return btn.disabled
}

// -- Tests ----------------------------------------------------------------

describe('Unified pagination (stack ↔ per-card sub-pages)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('Single card with sub-pages', () => {
    it('shows chevrons when a single card has multiple sub-pages', () => {
      render(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={3} />]}
        </PendingRequestStack>
      )

      // Pre-fix: count is the number of cards (1) → no chevrons rendered.
      // Post-fix: count is the sum of sub-pages (3) → chevrons appear.
      expect(paginationState()).not.toBeNull()
      expect(paginationLabel()).toBe('1 of 3')
    })

    it('Next advances to the next sub-page within the card', () => {
      render(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={3} />]}
        </PendingRequestStack>
      )

      clickNext()
      expect(paginationLabel()).toBe('2 of 3')
      expect(screen.getByTestId('A-content').textContent).toBe('A sub-page 1 of 3')
    })

    it('Prev rewinds to the previous sub-page', () => {
      render(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={3} />]}
        </PendingRequestStack>
      )

      clickNext()
      clickNext()
      expect(paginationLabel()).toBe('3 of 3')

      clickPrev()
      expect(paginationLabel()).toBe('2 of 3')
      expect(screen.getByTestId('A-content').textContent).toBe('A sub-page 1 of 3')
    })

    it('Prev is disabled at the first sub-page', () => {
      render(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={3} />]}
        </PendingRequestStack>
      )
      expect(isPrevDisabled()).toBe(true)
      expect(isNextDisabled()).toBe(false)
    })

    it('Next is disabled at the last sub-page', () => {
      render(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={3} />]}
        </PendingRequestStack>
      )

      clickNext()
      clickNext()
      expect(isNextDisabled()).toBe(true)
      expect(isPrevDisabled()).toBe(false)
    })

    it('clicking Next at the end is a no-op', () => {
      render(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={2} />]}
        </PendingRequestStack>
      )

      clickNext()
      clickNext() // Next click should be ignored (clamp at last)
      expect(paginationLabel()).toBe('2 of 2')
    })

    it('respects the card\'s initial sub-index', () => {
      render(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={4} initialIndex={2} />]}
        </PendingRequestStack>
      )
      expect(paginationLabel()).toBe('3 of 4')
      expect(screen.getByTestId('A-content').textContent).toBe('A sub-page 2 of 4')
    })
  })

  describe('Multiple cards with sub-pages', () => {
    it('totalCount is the sum of all cards\' sub-counts', () => {
      render(
        <PendingRequestStack>
          {[
            <MultiPageTestCard key="a" id="A" pages={3} />,
            <MultiPageTestCard key="b" id="B" pages={2} />,
          ]}
        </PendingRequestStack>
      )

      expect(paginationLabel()).toBe('1 of 5')
    })

    it('Next steps through every sub-page across cards in children order', () => {
      render(
        <PendingRequestStack>
          {[
            <MultiPageTestCard key="a" id="A" pages={3} />,
            <MultiPageTestCard key="b" id="B" pages={2} />,
          ]}
        </PendingRequestStack>
      )

      // Start: A page 0 (1 of 5)
      expect(paginationLabel()).toBe('1 of 5')
      expect(isCardVisible('A')).toBe(true)
      expect(isCardVisible('B')).toBe(false)

      clickNext() // A page 1 (2 of 5)
      expect(paginationLabel()).toBe('2 of 5')
      expect(isCardVisible('A')).toBe(true)

      clickNext() // A page 2 (3 of 5)
      expect(paginationLabel()).toBe('3 of 5')
      expect(isCardVisible('A')).toBe(true)

      clickNext() // crosses card boundary → B page 0 (4 of 5)
      expect(paginationLabel()).toBe('4 of 5')
      expect(isCardVisible('A')).toBe(false)
      expect(isCardVisible('B')).toBe(true)

      clickNext() // B page 1 (5 of 5)
      expect(paginationLabel()).toBe('5 of 5')
      expect(isCardVisible('B')).toBe(true)

      // Past the end → clamp
      clickNext()
      expect(paginationLabel()).toBe('5 of 5')
      expect(isNextDisabled()).toBe(true)
    })

    it('Prev rewinds across the card boundary onto the previous card\'s last sub-page', () => {
      render(
        <PendingRequestStack>
          {[
            <MultiPageTestCard key="a" id="A" pages={3} />,
            <MultiPageTestCard key="b" id="B" pages={2} />,
          ]}
        </PendingRequestStack>
      )

      // Advance into card B (4 of 5)
      clickNext()
      clickNext()
      clickNext()
      expect(isCardVisible('B')).toBe(true)
      expect(paginationLabel()).toBe('4 of 5')

      // Prev should land on card A's last sub-page (3 of 5), not skip to A page 0
      clickPrev()
      expect(paginationLabel()).toBe('3 of 5')
      expect(isCardVisible('A')).toBe(true)
      expect(screen.getByTestId('A-content').textContent).toBe('A sub-page 2 of 3')
    })

    it('the active card swaps exactly when crossing a boundary', () => {
      render(
        <PendingRequestStack>
          {[
            <MultiPageTestCard key="a" id="A" pages={2} />,
            <MultiPageTestCard key="b" id="B" pages={2} />,
            <MultiPageTestCard key="c" id="C" pages={2} />,
          ]}
        </PendingRequestStack>
      )

      // A active for indices 0..1, B for 2..3, C for 4..5
      expect(isCardVisible('A')).toBe(true)
      clickNext()
      expect(isCardVisible('A')).toBe(true)
      clickNext()
      expect(isCardVisible('B')).toBe(true)
      clickNext()
      expect(isCardVisible('B')).toBe(true)
      clickNext()
      expect(isCardVisible('C')).toBe(true)
      clickNext()
      expect(isCardVisible('C')).toBe(true)
      expect(paginationLabel()).toBe('6 of 6')
    })
  })

  describe('Mix of single-page and multi-page cards', () => {
    it('single-page cards contribute 1 to total count', () => {
      render(
        <PendingRequestStack>
          {[
            <SinglePageTestCard key="a" id="A" />,
            <MultiPageTestCard key="b" id="B" pages={3} />,
            <SinglePageTestCard key="c" id="C" />,
          ]}
        </PendingRequestStack>
      )

      // 1 + 3 + 1 = 5
      expect(paginationLabel()).toBe('1 of 5')
    })

    it('flattens correctly when single cards bracket a multi card', () => {
      render(
        <PendingRequestStack>
          {[
            <SinglePageTestCard key="a" id="A" />,
            <MultiPageTestCard key="b" id="B" pages={2} />,
            <SinglePageTestCard key="c" id="C" />,
          ]}
        </PendingRequestStack>
      )

      // Index 0 → A, 1 → B page 0, 2 → B page 1, 3 → C
      expect(isCardVisible('A')).toBe(true)
      clickNext()
      expect(isCardVisible('B')).toBe(true)
      expect(screen.getByTestId('B-content').textContent).toBe('B sub-page 0 of 2')
      clickNext()
      expect(isCardVisible('B')).toBe(true)
      expect(screen.getByTestId('B-content').textContent).toBe('B sub-page 1 of 2')
      clickNext()
      expect(isCardVisible('C')).toBe(true)
      expect(paginationLabel()).toBe('4 of 4')
    })

    it('flattens correctly when a multi card precedes a single card', () => {
      render(
        <PendingRequestStack>
          {[
            <MultiPageTestCard key="a" id="A" pages={2} />,
            <SinglePageTestCard key="b" id="B" />,
          ]}
        </PendingRequestStack>
      )

      // Index 0 → A page 0, 1 → A page 1, 2 → B
      expect(paginationLabel()).toBe('1 of 3')
      clickNext()
      expect(isCardVisible('A')).toBe(true)
      clickNext()
      expect(isCardVisible('B')).toBe(true)
    })
  })

  describe('Backwards compatibility', () => {
    it('a stack of all single-page cards behaves as before', () => {
      render(
        <PendingRequestStack>
          {[
            <SinglePageTestCard key="a" id="A" />,
            <SinglePageTestCard key="b" id="B" />,
          ]}
        </PendingRequestStack>
      )

      // No card publishes sub-pagination → fall back to per-card chevrons.
      expect(paginationLabel()).toBe('1 of 2')
      clickNext()
      expect(paginationLabel()).toBe('2 of 2')
      expect(isCardVisible('B')).toBe(true)
    })

    it('hides chevrons when total is 1 (single single-page card)', () => {
      render(
        <PendingRequestStack>
          {[<SinglePageTestCard key="a" id="A" />]}
        </PendingRequestStack>
      )

      expect(paginationState()).toBeNull()
    })

    it('hides chevrons when total is 1 (single multi-page card with pages=1)', () => {
      render(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={1} />]}
        </PendingRequestStack>
      )

      // 1 card × 1 sub-page = 1 → chevrons hidden.
      expect(paginationState()).toBeNull()
    })
  })

  describe('State preservation across pagination', () => {
    it('navigating away from a sub-paginated card preserves its sub-index', () => {
      render(
        <PendingRequestStack>
          {[
            <MultiPageTestCard key="a" id="A" pages={3} />,
            <MultiPageTestCard key="b" id="B" pages={2} />,
          ]}
        </PendingRequestStack>
      )

      // Advance to A page 1, then leap into card B
      clickNext() // A page 1
      clickNext() // A page 2
      clickNext() // B page 0
      expect(isCardVisible('B')).toBe(true)

      // Step back into A — should land on A's last sub-page (page 2), the
      // page we left A on, not A page 0.
      clickPrev()
      expect(isCardVisible('A')).toBe(true)
      expect(screen.getByTestId('A-content').textContent).toBe('A sub-page 2 of 3')
    })

    it('preserves DOM state (form inputs) across pagination', () => {
      render(
        <PendingRequestStack>
          {[
            <MultiPageTestCard key="a" id="A" pages={2} />,
            <MultiPageTestCard key="b" id="B" pages={2} />,
          ]}
        </PendingRequestStack>
      )

      // Type into A's input (visible card)
      const inputA = screen.getByTestId('A-input') as HTMLInputElement
      act(() => {
        inputA.value = 'hello'
        inputA.dispatchEvent(new Event('input', { bubbles: true }))
      })

      // Page through to card B and back
      clickNext()
      clickNext()
      clickNext()
      expect(isCardVisible('B')).toBe(true)
      clickPrev()
      clickPrev()
      clickPrev()
      expect(isCardVisible('A')).toBe(true)

      // Input is still mounted (visibility hidden, not unmounted) — value preserved
      expect((screen.getByTestId('A-input') as HTMLInputElement).value).toBe('hello')
    })
  })

  describe('Dynamic sub-counts', () => {
    it('totalCount reflects sub-count growth after mount', () => {
      const { rerender } = render(
        <PendingRequestStack>
          {[<DynamicSubCountCard key="a" id="A" pages={2} />]}
        </PendingRequestStack>
      )

      expect(paginationLabel()).toBe('1 of 2')

      rerender(
        <PendingRequestStack>
          {[<DynamicSubCountCard key="a" id="A" pages={4} />]}
        </PendingRequestStack>
      )

      expect(paginationLabel()).toBe('1 of 4')
    })

    it('totalCount reflects sub-count shrink and clamps current index', () => {
      const { rerender } = render(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={5} />]}
        </PendingRequestStack>
      )

      // Advance to page 4 (5 of 5)
      clickNext()
      clickNext()
      clickNext()
      clickNext()
      expect(paginationLabel()).toBe('5 of 5')

      // Shrink card A to 2 pages — index 4 must clamp to last valid (1, "2 of 2")
      rerender(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={2} />]}
        </PendingRequestStack>
      )

      expect(paginationLabel()).toBe('2 of 2')
    })
  })

  describe('Card removal', () => {
    it('removing a non-active card flattens correctly', () => {
      const { rerender } = render(
        <PendingRequestStack>
          {[
            <MultiPageTestCard key="a" id="A" pages={2} />,
            <MultiPageTestCard key="b" id="B" pages={3} />,
          ]}
        </PendingRequestStack>
      )

      expect(paginationLabel()).toBe('1 of 5')

      rerender(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={2} />]}
        </PendingRequestStack>
      )

      expect(paginationLabel()).toBe('1 of 2')
      expect(isCardVisible('A')).toBe(true)
    })

    it('removing the active card clamps and reveals the next', async () => {
      const { rerender } = render(
        <PendingRequestStack>
          {[
            <MultiPageTestCard key="a" id="A" pages={2} />,
            <MultiPageTestCard key="b" id="B" pages={2} />,
          ]}
        </PendingRequestStack>
      )

      await act(async () => {})

      // Remove card A — card B becomes the only card and should be visible.
      rerender(
        <PendingRequestStack>
          {[<MultiPageTestCard key="b" id="B" pages={2} />]}
        </PendingRequestStack>
      )

      await act(async () => {})

      expect(isCardVisible('B')).toBe(true)
      expect(paginationLabel()).toBe('1 of 2')
    })

    it('removing the last card after pagination clamps total index', () => {
      const { rerender } = render(
        <PendingRequestStack>
          {[
            <MultiPageTestCard key="a" id="A" pages={2} />,
            <MultiPageTestCard key="b" id="B" pages={3} />,
          ]}
        </PendingRequestStack>
      )

      // Move to B page 2 (5 of 5)
      clickNext()
      clickNext()
      clickNext()
      clickNext()
      expect(paginationLabel()).toBe('5 of 5')

      // Remove B — only A's 2 sub-pages remain; current index (4) must clamp.
      rerender(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={2} />]}
        </PendingRequestStack>
      )

      expect(paginationLabel()).toBe('2 of 2')
      expect(isCardVisible('A')).toBe(true)
    })
  })

  describe('Edge cases', () => {
    it('returns null for an empty stack', () => {
      const { container } = render(<PendingRequestStack>{[]}</PendingRequestStack>)
      expect(container.innerHTML).toBe('')
    })

    it('a card that registers count=0 contributes 0 to total', () => {
      render(
        <PendingRequestStack>
          {[
            <MultiPageTestCard key="a" id="A" pages={0} />,
            <MultiPageTestCard key="b" id="B" pages={2} />,
          ]}
        </PendingRequestStack>
      )

      // Only B's 2 pages count.
      expect(paginationLabel()).toBe('1 of 2')
    })

    it('no chevrons rendered when only a count=0 card is present', () => {
      render(
        <PendingRequestStack>
          {[<MultiPageTestCard key="a" id="A" pages={0} />]}
        </PendingRequestStack>
      )

      expect(paginationState()).toBeNull()
    })
  })

  describe('data attributes (for E2E tests)', () => {
    it('data-current-index reflects the flat index, not the card index', () => {
      render(
        <PendingRequestStack>
          {[
            <MultiPageTestCard key="a" id="A" pages={3} />,
            <MultiPageTestCard key="b" id="B" pages={2} />,
          ]}
        </PendingRequestStack>
      )

      expect(paginationState()).toEqual({ current: 0, total: 5 })

      clickNext()
      expect(paginationState()).toEqual({ current: 1, total: 5 })

      clickNext()
      clickNext()
      expect(paginationState()).toEqual({ current: 3, total: 5 })
    })
  })
})
