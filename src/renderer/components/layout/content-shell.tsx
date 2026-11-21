import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { SidebarTrigger } from '@renderer/components/ui/sidebar'
import { Separator } from '@renderer/components/ui/separator'
import { isElectron } from '@renderer/lib/env'
import { cn } from '@shared/lib/utils/cn'
import { ScrollAwareTitleProvider } from './scroll-aware-title'

const BackdropSlot = createContext<{ slot: HTMLElement | null; mount: () => () => void } | null>(null)
const CanvasMount = createContext<(() => () => void) | null>(null)

/**
 * Lays the off-white page (`bg-canvas`) under the whole shell while mounted, so
 * white panels on the view lift off it: Agent Home and a session ask for it.
 * Nothing outside a ContentShell.
 */
export function ContentCanvas() {
  const mount = useContext(CanvasMount)
  useEffect(() => mount?.(), [mount])
  return null
}

/**
 * Paints its children behind the whole shell, header included, so the header's
 * glass picks them up: Agent Home's halftone background. Children fill the
 * slot (`absolute inset-0`). Nothing outside a ContentShell.
 */
export function ContentBackdrop({ children }: { children: React.ReactNode }) {
  const backdrop = useContext(BackdropSlot)
  const mount = backdrop?.mount
  useEffect(() => mount?.(), [mount])
  return backdrop?.slot ? createPortal(children, backdrop.slot) : null
}

const HeaderTraySlotContext = createContext<{ slot: HTMLElement | null; setSlot: (slot: HTMLElement | null) => void } | null>(null)

/**
 * Where the header keeps the side drawer's toggle. The header decides whether
 * the view has one (a session does); the drawer, which lives in the body and
 * knows whether it is open, draws the button into it.
 */
export function HeaderTraySlot() {
  const tray = useContext(HeaderTraySlotContext)
  return <div ref={tray?.setSlot} className="flex items-center empty:hidden" data-testid="header-tray-slot" />
}

/** The header's place for the drawer toggle, or null where the header has none. */
export function useHeaderTraySlot(): HTMLElement | null {
  return useContext(HeaderTraySlotContext)?.slot ?? null
}

/**
 * The header + body frame shared by the agent view and the notifications route.
 */
export function ContentShell({
  needsTrafficLightPadding,
  headerContent,
  floatingHeader = false,
  children,
}: {
  needsTrafficLightPadding: boolean
  headerContent: React.ReactNode
  /**
   * A session's header: glass with a light line under it, floating over the chat so
   * the transcript scrolls up behind it, as it does behind the composer. The
   * view reads how far to reach up from `--header-overlap` (globals.css).
   */
  floatingHeader?: boolean
  children: React.ReactNode
}) {
  const [backdropSlot, setBackdropSlot] = useState<HTMLElement | null>(null)
  const [backdrops, setBackdrops] = useState(0)
  const mount = useCallback(() => {
    setBackdrops(count => count + 1)
    return () => setBackdrops(count => count - 1)
  }, [])
  const backdrop = useMemo(() => ({ slot: backdropSlot, mount }), [backdropSlot, mount])
  const [canvases, setCanvases] = useState(0)
  const mountCanvas = useCallback(() => {
    setCanvases(count => count + 1)
    return () => setCanvases(count => count - 1)
  }, [])
  const [traySlot, setTraySlot] = useState<HTMLElement | null>(null)
  const headerTray = useMemo(() => ({ slot: traySlot, setSlot: setTraySlot }), [traySlot])
  // Glass only over a backdrop: over the plain canvas it shows nothing, yet a
  // backdrop-filter still re-samples whatever is behind it on every frame.
  const glass = backdrops > 0
  const canvas = canvases > 0
  // A floating header is out of flow, so the body is pushed down by its height,
  // measured: on a narrow window the header can wrap to more than one row.
  const [header, setHeader] = useState<HTMLElement | null>(null)
  const [headerHeight, setHeaderHeight] = useState(48)
  useLayoutEffect(() => {
    if (!floatingHeader || !header) return
    const measure = () => setHeaderHeight(Math.ceil(header.getBoundingClientRect().height) || 48)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    return () => observer.disconnect()
  }, [floatingHeader, header])
  return (
    <ScrollAwareTitleProvider>
      <HeaderTraySlotContext.Provider value={headerTray}>
      {/* Its own stacking context, so the backdrop below the header and view stays above the page. */}
      <div
        className={cn('relative isolate h-full flex flex-col', canvas && 'bg-canvas', floatingHeader && 'floating-header-shell')}
        style={floatingHeader ? { paddingTop: headerHeight, ['--floating-header' as string]: `${headerHeight}px` } : undefined}
        data-testid="main-content"
        data-backdrop={glass ? '' : undefined}
      >
        <div ref={setBackdropSlot} className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" />
        <header
          ref={setHeader}
          className={cn(
            'shrink-0 flex min-h-12 py-1.5 md:py-0 md:h-12 items-center gap-2 pl-4 pr-2',
            // The composer's glass (FLOATING_COMPOSER_CLASS), without its shadow: a bar, not a card. Its line is
            // half the usual weight, so the chat passing under it reads through instead of being cut off.
            // On a view with the off-white page the header is that colour too, glass or not.
            floatingHeader
              ? cn(
                  'absolute inset-x-0 top-0 z-20 border-b border-border/50 backdrop-blur-md',
                  canvas ? 'bg-canvas/85 supports-[backdrop-filter]:bg-canvas/65' : 'bg-background/85 supports-[backdrop-filter]:bg-background/65',
                )
              : cn(
                  'border-b',
                  glass
                    ? cn(canvas ? 'bg-canvas/50' : 'bg-background/50', 'backdrop-blur-xl backdrop-saturate-150')
                    : canvas ? 'bg-canvas' : 'bg-background',
                ),
            isElectron() && 'app-drag-region',
          )}
          data-floating={floatingHeader || undefined}
        >
          <SidebarTrigger className={`app-no-drag ${needsTrafficLightPadding ? 'ml-16' : '-ml-1'}`} />
          <Separator orientation="vertical" className="h-5 hidden md:block" />
          {headerContent}
        </header>
        <CanvasMount.Provider value={mountCanvas}>
          <BackdropSlot.Provider value={backdrop}>{children}</BackdropSlot.Provider>
        </CanvasMount.Provider>
      </div>
      </HeaderTraySlotContext.Provider>
    </ScrollAwareTitleProvider>
  )
}
