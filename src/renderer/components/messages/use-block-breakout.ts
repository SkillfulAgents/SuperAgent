import { useLayoutEffect, type RefObject } from 'react'

// Side breathing room kept between an expanded block and the chat edges.
const BREAKOUT_GUTTER = 16

// A wide block (many-column table, large diagram) shouldn't be crammed into the
// narrow readable text column. Like Notion, we let a block that's wider than the
// column break out and centre itself across the available chat width, scrolling
// horizontally only once it still exceeds that. Narrow blocks are left untouched
// in the normal text flow. The breakout is measured rather than pure-CSS because
// the block is nested several constrained, off-centre ancestors deep, so there is
// no static containing block to anchor a symmetric breakout to. Only assistant
// messages opt in (via `data-allow-table-breakout`); elsewhere the block just
// scrolls inside its own column.
export function useBlockBreakout(
  wrapperRef: RefObject<HTMLElement | null>,
  scrollerRef: RefObject<HTMLElement | null>,
  content: unknown,
): void {
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current
    const scroller = scrollerRef.current
    if (!wrapper || !scroller) return

    const contentArea = wrapper.closest('[data-message-content-area]') as HTMLElement | null
    const canBreakOut = !!wrapper.closest('[data-allow-table-breakout]')

    const measure = () => {
      // Always start from the natural in-flow geometry before deciding.
      wrapper.style.width = ''
      wrapper.style.marginLeft = ''

      if (!contentArea || !canBreakOut) return

      const columnWidth = wrapper.clientWidth
      const naturalWidth = scroller.scrollWidth
      // Only break out when the block genuinely wants more than the column.
      if (naturalWidth <= columnWidth + 1) return

      const available = contentArea.clientWidth - BREAKOUT_GUTTER * 2
      if (available <= columnWidth) return // window too narrow to gain anything

      const target = Math.min(naturalWidth, available)
      const areaLeft = contentArea.getBoundingClientRect().left + BREAKOUT_GUTTER
      const currentLeft = wrapper.getBoundingClientRect().left
      const desiredLeft = areaLeft + (available - target) / 2

      wrapper.style.width = `${target}px`
      wrapper.style.marginLeft = `${desiredLeft - currentLeft}px`
    }

    measure()

    if (!contentArea || !canBreakOut || typeof ResizeObserver === 'undefined') return
    // Re-centre when the chat area resizes. Content changes (e.g. a table still
    // streaming) re-run this effect via the `content` dependency, so we don't
    // observe the block itself — that would risk a resize-observer feedback loop.
    const observer = new ResizeObserver(() => measure())
    observer.observe(contentArea)
    return () => observer.disconnect()
  }, [wrapperRef, scrollerRef, content])
}
