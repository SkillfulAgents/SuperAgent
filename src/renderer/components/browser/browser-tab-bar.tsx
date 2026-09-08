import type { ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Eye, EyeOff, Globe, Loader2, X } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'

import type { BrowserTabInfo } from '@shared/lib/browser-stream-protocol'
export type { BrowserTabInfo } from '@shared/lib/browser-stream-protocol'

/**
 * The tab's favicon, or a globe when there is none or it fails to load. The
 * failure is remembered per URL so a dead icon does not retry on every render.
 */
function TabIcon({ faviconUrl, title }: { faviconUrl?: string; title: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (!faviconUrl || failedUrl === faviconUrl) {
    return <Globe className="h-3.5 w-3.5 text-inherit" data-testid="browser-tab-globe" />
  }
  return (
    <img
      src={faviconUrl}
      alt=""
      aria-hidden
      className="h-3.5 w-3.5 rounded-sm object-contain"
      data-testid="browser-tab-favicon"
      data-title={title}
      onError={() => setFailedUrl(faviconUrl)}
    />
  )
}

interface BrowserTabBarProps {
  tabs: BrowserTabInfo[]
  viewingTargetId: string | null
  autoFollow: boolean
  loading?: boolean
  onTabClick: (targetId: string) => void
  onCloseTab?: (targetId: string) => void
  onToggleAutoFollow: () => void
  /**
   * Whether the viewed tab's left edge is flush with the strip's left inset —
   * true only for the first tab, unscrolled. The body card squares off its
   * top-left corner to meet the tab when it is.
   */
  onLeadingTabFlush?: (flush: boolean) => void
  /** Panel-level controls rendered after the last tab, at the strip's right edge (the drawer close). */
  trailing?: ReactNode
}

/** Sub-pixel slack: a scroller's scrollLeft rarely lands exactly on zero. */
const EDGE_EPSILON_PX = 1

function tabLabel(tab: BrowserTabInfo): string {
  return tab.title || tab.url || `Tab ${tab.index + 1}`
}

/**
 * The browser drawer's tab strip, in the same Chrome-style dress as the file
 * drawer's (`file-tab-bar.tsx`): tabs on a gray rail, the viewed tab raised as
 * a card whose open bottom hides the body's top border, labels that fade out
 * instead of ellipsizing.
 *
 * Unlike the file strip it always renders, even with no tabs: the drawer's own
 * controls (auto-follow, hide panel) live at its right end, and a browser that
 * is still connecting has a drawer to hide before it has a page to show.
 */
export function BrowserTabBar({
  tabs,
  viewingTargetId,
  autoFollow,
  loading,
  onTabClick,
  onCloseTab,
  onToggleAutoFollow,
  onLeadingTabFlush,
  trailing,
}: BrowserTabBarProps) {
  const groupRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [scrollLeft, setScrollLeft] = useState(0)

  const viewingIndex = tabs.findIndex((tab) => tab.targetId === viewingTargetId)

  /** Scroll just far enough to bring a tab fully into the strip. */
  const reveal = useCallback((index: number) => {
    const group = groupRef.current
    const track = trackRef.current
    const tab = track?.children[index] as HTMLElement | undefined
    if (!group || !track || !tab) return
    const left = tab.offsetLeft - track.offsetLeft
    const right = left + tab.offsetWidth
    if (left < group.scrollLeft) {
      group.scrollTo({ left, behavior: 'smooth' })
    } else if (right > group.scrollLeft + group.clientWidth) {
      group.scrollTo({ left: right - group.clientWidth, behavior: 'smooth' })
    }
  }, [])

  useLayoutEffect(() => {
    if (viewingIndex >= 0) reveal(viewingIndex)
  }, [reveal, viewingIndex, tabs.length])

  const atStart = scrollLeft <= EDGE_EPSILON_PX
  useEffect(() => {
    onLeadingTabFlush?.(viewingIndex === 0 && atStart)
  }, [onLeadingTabFlush, viewingIndex, atStart])

  return (
    <div
      // pl-4 matches the body card's 16px inset, so the first tab's left edge
      // is flush with the card's (the card's top-left corner is square for this).
      className="relative flex items-end bg-muted/60 pl-4 pr-2 pt-1.5 shrink-0"
      data-testid="browser-tab-bar"
    >
      {/* pb-px/-mb-px holds the viewed tab's 1px overhang onto the body card
          without letting the vertical axis overflow (see file-tab-bar.tsx). */}
      <div
        ref={groupRef}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        className="file-tab-scroller min-w-0 flex-1 -mb-px overflow-x-auto overflow-y-hidden pb-px"
      >
        <div ref={trackRef} className="flex w-full items-end gap-px">
          {tabs.map((tab, index) => {
            const isViewing = tab.targetId === viewingTargetId
            const isAgentActive = tab.active
            const label = tabLabel(tab)

            return (
              <ContextMenu key={tab.targetId}>
                <ContextMenuTrigger asChild>
                  {/* A shell, not a control: it holds the select and close
                      buttons, and a <button> may not contain another. */}
                  <div
                    data-testid="browser-tab"
                    data-active={isViewing || undefined}
                    className={cn(
                      'group relative flex h-8 flex-[0_1_160px] items-center rounded-t-lg pr-2 text-left text-xs transition-colors',
                      isViewing
                        ? 'z-10 min-w-[9.5rem] -mb-px border border-b-0 border-black/5 bg-background text-foreground shadow-[0_-1px_2px_rgba(0,0,0,0.04)] dark:border-white/5'
                        : 'min-w-[4.25rem] text-foreground hover:bg-background/60',
                      // hairline separator on the left of inactive tabs that don't touch the viewed card
                      index > 0 && index !== viewingIndex && index - 1 !== viewingIndex &&
                        'before:absolute before:left-0 before:top-2 before:bottom-2 before:w-px before:bg-border/60',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onTabClick(tab.targetId)}
                      onFocus={() => reveal(index)}
                      title={tab.title || tab.url}
                      data-testid="browser-tab-select"
                      className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 pr-1 text-left"
                    >
                      <span className="relative shrink-0">
                        <TabIcon faviconUrl={tab.faviconUrl} title={label} />
                        {isAgentActive && (
                          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                        )}
                      </span>
                      {/* Overflowing names fade out at the right edge instead of ellipsizing, as in Chrome. */}
                      <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)]">
                        {label}
                      </span>
                    </button>
                    {/* The agent's own tab cannot be closed out from under it,
                        so that one has no close control at all. */}
                    {onCloseTab && !isAgentActive && (
                      <button
                        type="button"
                        data-testid="browser-tab-close"
                        aria-label={`Close ${label}`}
                        onClick={() => onCloseTab(tab.targetId)}
                        className={cn(
                          'shrink-0 rounded p-0.5 text-muted-foreground transition-opacity hover:bg-muted-foreground/20 hover:text-foreground group-hover:opacity-100 touch:opacity-100',
                          isViewing ? 'opacity-100' : 'opacity-0',
                        )}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    disabled={isAgentActive}
                    onClick={() => onCloseTab?.(tab.targetId)}
                  >
                    Close tab
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      </div>

      {/* ml-auto pins the controls right; pr-1.5 + the strip's pr-2 + the
          buttons' p-0.5 puts the last icon's edge at 16px, flush with the body card. */}
      {/* ml-auto pins the controls right; pr-1.5 + the strip's pr-2 + the
          buttons' p-0.5 puts the last icon's edge at 16px, flush with the body card. */}
      <div className="ml-auto flex h-8 shrink-0 items-center gap-1 pl-1 pr-1.5 text-muted-foreground">
        {loading && <Loader2 className="h-3 w-3 animate-spin shrink-0" />}
        <button
          type="button"
          className={cn(
            'p-0.5 rounded transition-colors shrink-0',
            autoFollow ? 'text-blue-500 hover:text-blue-600' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={onToggleAutoFollow}
          title={autoFollow ? 'Auto-following agent (click to pin)' : 'Not following agent (click to follow)'}
          aria-label={autoFollow ? 'Auto-following agent (click to pin)' : 'Not following agent (click to follow)'}
        >
          {autoFollow ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </button>
        {trailing}
      </div>
    </div>
  )
}
