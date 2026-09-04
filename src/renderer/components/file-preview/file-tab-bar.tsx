import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { cn } from '@shared/lib/utils/cn'
import { getPreviewTabKey, type PreviewTab } from '@renderer/context/file-preview-context'

interface FileTabBarProps {
  tabs: PreviewTab[]
  activeIndex: number
  onTabClick: (index: number) => void
  onCloseTab: (tabKey: string) => void
  /**
   * Whether the active tab's left edge is flush with the strip's left inset —
   * true only for the first tab, unscrolled. The body card squares off its
   * top-left corner to meet the tab when it is.
   */
  onLeadingTabFlush?: (flush: boolean) => void
  /** Panel-level controls rendered after the last tab, at the strip's right edge (the drawer close). */
  trailing?: ReactNode
}

const TAB_GAP_PX = 1
/** Sub-pixel slack: a scroller's scrollLeft rarely lands exactly on its maximum. */
const EDGE_EPSILON_PX = 1

/**
 * Chrome-style tab strip.
 *
 * Tabs share one 160px basis and shrink in lockstep down to a floor — except
 * the active one, which keeps enough width to read its own name. Past the floor
 * they overflow and the strip shows a pair of arrows that scroll it one tab at
 * a time.
 *
 * The strip is a real horizontal scroller, so a trackpad swipe, a touch drag
 * and the browser's own focus-reveal all work without us reimplementing them.
 * The reason it originally wasn't one is that the active tab hangs 1px below
 * the track to cover the body card's top border, and a scroll container clips
 * that overhang: `pb-px -mb-px` buys the overhang a pixel of padding to live
 * in, which keeps it visible and keeps the vertical axis from overflowing.
 */
export function FileTabBar({ tabs, activeIndex, onTabClick, onCloseTab, onLeadingTabFlush, trailing }: FileTabBarProps) {
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
  }, [measure, tabs.length, activeIndex])

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
  }, [reveal, activeIndex, tabs.length])

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

  if (tabs.length === 0) return null

  return (
    <div
      // pl-4 matches the body card's 16px inset, so the first tab's left edge
      // is flush with the card's (the card's top-left corner is square for this).
      className="relative flex items-end bg-muted/60 pl-4 pr-2 pt-1.5 shrink-0"
      data-testid="file-tab-bar"
      data-overflowing={overflowing || undefined}
    >
      {/* Bounded to the space left after the arrows and trailing control.
          pb-px/-mb-px holds the active tab's 1px overhang without letting the
          vertical axis overflow (see the component comment). */}
      <div
        ref={groupRef}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        className="file-tab-scroller min-w-0 flex-1 -mb-px overflow-x-auto overflow-y-hidden pb-px"
        data-testid="file-tab-group"
      >
        <div ref={trackRef} className="flex w-full items-end gap-px">
          {tabs.map((tab, index) => (
            <button
              key={getPreviewTabKey(tab)}
              type="button"
              onClick={() => onTabClick(index)}
              // A clipped tab is still in the tab order, and the strip cannot
              // rely on the browser to reveal it during a smooth scroll of its
              // own; bring it in explicitly.
              onFocus={() => reveal(index)}
              data-testid="file-tab"
              data-tab-kind={tab.kind}
              data-file-name={tab.displayName}
              data-path={tab.kind === 'file' ? tab.filePath : tab.rootPath}
              data-active={index === activeIndex || undefined}
              className={cn(
                // Uniform tabs, like Chrome: every tab starts from the same 160px basis
                // and shrinks in lockstep, down to a floor that still fits icon + close.
                'group relative flex h-8 flex-[0_1_160px] items-center gap-1.5 rounded-t-lg px-3 text-left text-xs transition-colors',
                index === activeIndex
                  // The one tab whose name the user needs to read is the one
                  // they are looking at, so it holds a floor wide enough for a
                  // label while the rest collapse to icon + close.
                  ? 'z-10 min-w-[9.5rem] -mb-px border border-b-0 border-black/5 bg-background text-foreground shadow-[0_-1px_2px_rgba(0,0,0,0.04)] dark:border-white/5'
                  : 'min-w-[4.25rem] text-foreground hover:bg-background/60',
                // hairline separator on the left of inactive tabs that don't touch the active card
                index > 0 && index !== activeIndex && index - 1 !== activeIndex &&
                  'before:absolute before:left-0 before:top-2 before:bottom-2 before:w-px before:bg-border/60',
              )}
            >
              {/* Follow the tab's own color so the icon darkens with the label on the
                  active tab and on hover, instead of the icon's muted default. */}
              <FileTypeIcon filename={tab.displayName} size="sm" folder={tab.kind === 'folder'} className="text-inherit" />
              {/* Overflowing names fade out at the right edge instead of ellipsizing, as in Chrome. */}
              <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)]">
                {tab.displayName}
              </span>
              <span
                role="button"
                tabIndex={0}
                data-testid="file-tab-close"
                data-file-name={tab.displayName}
                data-path={tab.kind === 'file' ? tab.filePath : tab.rootPath}
                aria-label={`Close ${tab.displayName}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseTab(getPreviewTabKey(tab))
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation()
                    e.preventDefault()
                    onCloseTab(getPreviewTabKey(tab))
                  }
                }}
                className={cn(
                  'ml-auto shrink-0 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-muted-foreground/20 hover:text-foreground group-hover:opacity-100 touch:opacity-100',
                  // the selected tab keeps its close visible; the rest reveal it on hover
                  index === activeIndex ? 'opacity-100' : 'opacity-0',
                )}
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
      </div>

      {overflowing && (
        <div className="flex h-8 shrink-0 items-center pl-1 text-muted-foreground" data-testid="file-tab-arrows">
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
      {trailing && <div className="ml-auto flex h-8 shrink-0 items-center pl-1 pr-1.5 text-muted-foreground">{trailing}</div>}
    </div>
  )
}
