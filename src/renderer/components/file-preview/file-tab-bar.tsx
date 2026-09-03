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
  /** Panel-level controls rendered after the last tab, at the strip's right edge (the drawer close). */
  trailing?: ReactNode
}

const TAB_GAP_PX = 1

/**
 * Chrome-style tab strip.
 *
 * Tabs share one 160px basis and shrink in lockstep down to a floor. Past the
 * floor they overflow, and the strip shows a pair of arrows that slide the
 * track one tab at a time. The track is *translated* inside a group that clips
 * only horizontally — not scrolled — because a scroll container also clips
 * vertically, and the active tab hangs 1px over the body card's top border to
 * hide the line beneath it.
 */
export function FileTabBar({ tabs, activeIndex, onTabClick, onCloseTab, trailing }: FileTabBarProps) {
  const groupRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  const [maxOffset, setMaxOffset] = useState(0)

  /** How far the track can slide: the content width beyond the visible group. */
  const measure = useCallback(() => {
    const group = groupRef.current
    if (!group) return 0
    const max = Math.max(0, group.scrollWidth - group.clientWidth)
    setMaxOffset(max)
    setOffset((o) => Math.min(o, max))
    return max
  }, [])

  useLayoutEffect(() => {
    measure()
  }, [measure, tabs.length])

  useEffect(() => {
    const group = groupRef.current
    if (!group || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(group)
    return () => observer.disconnect()
  }, [measure])

  // Keep the active tab in view: slide just far enough to reveal it.
  useLayoutEffect(() => {
    const group = groupRef.current
    const tab = trackRef.current?.children[activeIndex] as HTMLElement | undefined
    if (!group || !tab) return
    const left = tab.offsetLeft
    const right = left + tab.offsetWidth
    setOffset((o) => {
      if (left < o) return left
      if (right > o + group.clientWidth) return Math.max(0, right - group.clientWidth)
      return o
    })
  }, [activeIndex, tabs.length, maxOffset])

  const step = () => {
    const first = trackRef.current?.children[0] as HTMLElement | undefined
    return (first?.offsetWidth ?? 160) + TAB_GAP_PX
  }
  const slideLeft = () => setOffset((o) => Math.max(0, o - step()))
  const slideRight = () => setOffset((o) => Math.min(maxOffset, o + step()))

  if (tabs.length === 0) return null

  const overflowing = maxOffset > 0
  const atStart = offset <= 0
  const atEnd = offset >= maxOffset

  return (
    <div
      // pl-4 matches the body card's 16px inset, so the first tab's left edge
      // is flush with the card's (the card's top-left corner is square for this).
      className="relative flex items-end bg-muted/60 pl-4 pr-2 pt-1.5 shrink-0"
      data-testid="file-tab-bar"
      data-overflowing={overflowing || undefined}
    >
      {/* Bounded to the space left after the arrows and trailing control.
          overflow-x-clip (not hidden) keeps the vertical axis visible. */}
      <div ref={groupRef} className="min-w-0 flex-1 overflow-x-clip" data-testid="file-tab-group">
        <div
          ref={trackRef}
          className="flex w-full items-end gap-px transition-transform duration-200 ease-out"
          style={{ transform: `translateX(-${offset}px)` }}
        >
          {tabs.map((tab, index) => (
            <button
              key={getPreviewTabKey(tab)}
              type="button"
              onClick={() => onTabClick(index)}
              data-testid="file-tab"
              data-tab-kind={tab.kind}
              data-file-name={tab.displayName}
              data-path={tab.kind === 'file' ? tab.filePath : tab.rootPath}
              data-active={index === activeIndex || undefined}
              className={cn(
                // Uniform tabs, like Chrome: every tab starts from the same 160px basis
                // and shrinks in lockstep, down to a floor that still fits icon + close.
                'group relative flex h-8 flex-[0_1_160px] min-w-[4.25rem] items-center gap-1.5 rounded-t-lg px-3 text-left text-xs transition-colors',
                index === activeIndex
                  ? 'z-10 -mb-px border border-b-0 border-black/5 bg-background text-foreground shadow-[0_-1px_2px_rgba(0,0,0,0.04)] dark:border-white/5'
                  : 'text-foreground hover:bg-background/60',
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
            onClick={slideLeft}
            disabled={atStart}
            aria-label="Earlier tabs"
            className="rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={slideRight}
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
