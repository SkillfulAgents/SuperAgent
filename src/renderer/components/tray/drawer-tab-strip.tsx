import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

interface DrawerTabStripProps {
  tabCount: number
  activeIndex: number
  onLeadingTabFlush?: (flush: boolean) => void
  trailing?: ReactNode
  testId: string
  children: (reveal: (index: number) => void) => ReactNode
}

/** Shared scrolling, focus reveal, overflow controls, and card alignment for drawer tabs. */
const TAB_GAP_PX = 1
/** Sub-pixel slack: a scroller's scrollLeft rarely lands exactly on its maximum. */
const EDGE_EPSILON_PX = 1

export function DrawerTabStrip({
  tabCount,
  activeIndex,
  onLeadingTabFlush,
  trailing,
  testId,
  children,
}: DrawerTabStripProps) {
  const groupRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [maxScroll, setMaxScroll] = useState(0)

  /** How far the strip can scroll: the content width beyond the visible group. */
  const measure = useCallback(() => {
    const group = groupRef.current
    if (!group) return
    setMaxScroll(Math.max(0, group.scrollWidth - group.clientWidth))
    setScrollLeft(group.scrollLeft)
  }, [])

  // The active tab is wider than the rest, so selecting one changes the content
  // width as well as adding or removing a tab does.
  useLayoutEffect(() => {
    measure()
  }, [measure, tabCount, activeIndex])

  useEffect(() => {
    const group = groupRef.current
    if (!group || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(group)
    return () => observer.disconnect()
  }, [measure])

  /** Scroll just far enough to bring a tab fully into the strip. */
  const reveal = useCallback((index: number) => {
    const group = groupRef.current
    const track = trackRef.current
    const tab = track?.children[index] as HTMLElement | undefined
    if (!group || !track || !tab) return
    // offsetLeft is measured against the positioned strip, not the scroll
    // content; subtracting the track's own offset puts both on the same axis
    // as scrollLeft.
    const left = tab.offsetLeft - track.offsetLeft
    const right = left + tab.offsetWidth
    if (left < group.scrollLeft) {
      group.scrollTo({ left, behavior: 'smooth' })
    } else if (right > group.scrollLeft + group.clientWidth) {
      group.scrollTo({ left: right - group.clientWidth, behavior: 'smooth' })
    }
  }, [])

  useLayoutEffect(() => {
    reveal(activeIndex)
  }, [reveal, activeIndex, tabCount])

  const atStart = scrollLeft <= EDGE_EPSILON_PX
  const atEnd = scrollLeft >= maxScroll - EDGE_EPSILON_PX
  const overflowing = maxScroll > 0

  useEffect(() => {
    onLeadingTabFlush?.(activeIndex === 0 && atStart)
  }, [onLeadingTabFlush, activeIndex, atStart])

  /**
   * One tab's worth of travel. The active tab is deliberately wider than its
   * neighbours, so a step measured off it would overshoot; sample another.
   */
  const step = () => {
    const children = Array.from(trackRef.current?.children ?? []) as HTMLElement[]
    const sample = children.find((_, index) => index !== activeIndex) ?? children[0]
    return (sample?.offsetWidth ?? 160) + TAB_GAP_PX
  }
  const slide = (direction: -1 | 1) => {
    groupRef.current?.scrollBy({ left: direction * step(), behavior: 'smooth' })
  }

  return (
    <div
      // pl-4 matches the body card's 16px inset, so the first tab's left edge
      // is flush with the card's (the card's top-left corner is square for this).
      className="relative flex items-end bg-muted/60 pl-4 pr-2 pt-1.5 shrink-0"
      data-testid={`${testId}-bar`}
      data-overflowing={overflowing || undefined}
    >
      {/* Bounded to the space left after the arrows and trailing control.
          pb-px/-mb-px holds the active tab's 1px overhang without letting the
          vertical axis overflow. */}
      <div
        ref={groupRef}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        className="file-tab-scroller min-w-0 flex-1 -mb-px overflow-x-auto overflow-y-hidden pb-px"
        data-testid={`${testId}-group`}
      >
        <div ref={trackRef} className="flex w-full items-end gap-px">
          {children(reveal)}
        </div>
      </div>

      {overflowing && (
        <div className="flex h-8 shrink-0 items-center pl-1 text-muted-foreground" data-testid={`${testId}-arrows`}>
          <button
            type="button"
            onClick={() => slide(-1)}
            disabled={atStart}
            aria-label="Earlier tabs"
            className="rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => slide(1)}
            disabled={atEnd}
            aria-label="Later tabs"
            className="rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ml-auto pins it right; pr-1.5 + the strip's pr-2 + the button's p-0.5 puts the icon's edge at 16px, flush with the body card. */}
      {trailing && (
        <div className="ml-auto flex h-8 shrink-0 items-center gap-1 pl-1 pr-1.5 text-muted-foreground">{trailing}</div>
      )}
    </div>
  )
}

/** Shared tab geometry; icons, menus, and close behavior belong to each caller. */
export function drawerTabClassName(index: number, activeIndex: number) {
  return cn(
    'group relative flex h-8 flex-[0_1_160px] items-center rounded-t-lg pr-2 text-left text-xs transition-colors',
    index === activeIndex
      ? 'z-10 min-w-[9.5rem] -mb-px border border-b-0 border-black/5 bg-background text-foreground shadow-[0_-1px_2px_rgba(0,0,0,0.04)] dark:border-white/5'
      : 'min-w-[4.25rem] text-foreground hover:bg-background/60',
    index > 0 &&
      index !== activeIndex &&
      index - 1 !== activeIndex &&
      'before:absolute before:left-0 before:top-2 before:bottom-2 before:w-px before:bg-border/60',
  )
}
